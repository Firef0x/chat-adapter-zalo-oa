import { extractFiles, NetworkError, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  Logger,
  RawMessage,
  ThreadInfo,
  UserInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";
import crypto from "node:crypto";

import { ZaloOaApiClient } from "./lib/api-client.js";
import { BoundedSet } from "./lib/bounded-set.js";
import { ZaloOaFormatConverter } from "./lib/format-converter.js";
import { ZaloOaGroups } from "./lib/groups.js";
import { lookup } from "./lib/lookup.js";
import { mimeTypeForExtension, prepareMedia, toBuffer, uploadMedia } from "./lib/media.js";
import {
  fromZaloReactIcon,
  supportedReactions,
  toZaloReactIcon,
  ZALO_REMOVE_REACTION,
} from "./lib/reactions.js";
import {
  ADAPTER_NAME,
  channelIdFromThreadId,
  decodeChannelId,
  decodeThreadId,
  encodeThreadId,
} from "./lib/thread-id.js";
import { ZaloOaTokenManager } from "./lib/token-manager.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./lib/webhook.js";
import type {
  ZaloOaAdapterConfig,
  ZaloOaHistoryMessage,
  ZaloOaInfo,
  ZaloOaOutboundMessage,
  ZaloOaPhoneTemplateData,
  ZaloOaPhoneTemplateResult,
  ZaloOaRawMessage,
  ZaloOaSendMessageData,
  ZaloOaTemplateData,
  ZaloOaTemplateStatus,
  ZaloOaTemplateSummary,
  ZaloOaThreadId,
  ZaloOaUserDetail,
  ZaloOaWebhookAttachment,
  ZaloOaWebhookEvent,
} from "./types.js";

/** Zalo rejects consultation text longer than this. */
const MAX_TEXT_LENGTH = 2000;

/** Largest attachment `fetchData()` buffers unless configured otherwise: 50 MiB. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * An ID from a Zalo payload, as a string.
 *
 * The docs show IDs as strings, but a number is accepted rather than
 * misread: compared strictly, it would fail every ownership check.
 */
function idOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** The one-to-one history endpoint returns at most this many messages per request. */
const HISTORY_PAGE_SIZE = 10;

/**
 * Page size for group history.
 *
 * Zalo documents a default of five and no maximum. Asking for more risks a
 * page silently capped below the request, which the pager would read as the
 * end of the history and stop with older messages still unread. Five is the
 * one size Zalo is known to serve in full.
 */
const GROUP_HISTORY_PAGE_SIZE = 5;

const REQUIRED_CREDENTIALS = [
  "appId",
  "appSecret",
  "oaSecretKey",
  "oaId",
  "accessToken",
  "refreshToken",
] as const;

/**
 * The earliest epoch-millisecond value accepted as a real message time
 * (2010-01-01). Anything smaller is a seconds value, a zero, or garbage, and
 * would date the message to 1970.
 */
const MIN_PLAUSIBLE_TIMESTAMP_MS = 1_262_304_000_000;

function parseTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_PLAUSIBLE_TIMESTAMP_MS) {
    return undefined;
  }
  return parsed;
}

// Each takes `unknown`: `parseMessage()` is public, and a payload whose
// `event_name` is missing or not a string must be refused, not crash on
// `.startsWith`.

/** A user's message in a GMF group chat. */
function isGroupMessageEvent(eventName: unknown): boolean {
  return typeof eventName === "string" && eventName.startsWith("user_send_group_");
}

/** A user's message to the OA, one to one. */
function isUserMessageEvent(eventName: unknown): boolean {
  return (
    typeof eventName === "string" &&
    eventName.startsWith("user_send_") &&
    !isGroupMessageEvent(eventName)
  );
}

/** A message from an anonymous user of the OA's chat widget. */
function isAnonymousMessageEvent(eventName: unknown): boolean {
  return typeof eventName === "string" && eventName.startsWith("anonymous_send_");
}

/**
 * A phone number in the form Zalo wants: the country code and the number,
 * digits only, with or without a leading `+`. `0987654321` in Vietnam is
 * `84987654321`.
 */
const PHONE = /^\+?[1-9]\d{7,14}$/;

/** Zalo asks that a tracking ID be at most 48 characters with no special characters. */
const TRACKING_ID = /^[A-Za-z0-9_-]{1,48}$/;

/** Group events name the message `message_id` in their field table and `msg_id` in their example. */
function messageIdOf(message: ZaloOaWebhookEvent["message"]): string {
  return idOf(message?.msg_id) || idOf(message?.message_id);
}

export const ZALO_BUSINESS_API_HOST = "https://business.openapi.zalo.me";

/** The ZBS list endpoint returns at most this many templates per request. */
const TEMPLATE_PAGE_LIMIT = 100;

const TEMPLATE_STATUS_CODES: Readonly<Record<ZaloOaTemplateStatus, number>> = {
  ENABLE: 1,
  PENDING_REVIEW: 2,
  REJECT: 3,
  DISABLE: 4,
};

/** Webhook attachment types that map onto a Chat SDK attachment. */
const ATTACHMENT_KINDS: Readonly<Record<string, Attachment["type"]>> = {
  image: "image",
  gif: "image",
  sticker: "image",
  video: "video",
  audio: "audio",
  file: "file",
};

/** History entry types that carry a downloadable URL. */
const HISTORY_ATTACHMENT_KINDS: Readonly<Record<string, Attachment["type"]>> = {
  photo: "image",
  GIF: "image",
  sticker: "image",
  voice: "audio",
};

/**
 * Chat SDK adapter for the Zalo Official Account API.
 *
 * Inbound messages arrive as webhooks; outbound messages go through the
 * consultation endpoint. Everything the platform or this release cannot do
 * throws rather than failing quietly.
 */
export class ZaloOaAdapter implements Adapter<ZaloOaThreadId, ZaloOaRawMessage> {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  readonly botUserId: string;

  private chat: ChatInstance | null = null;
  private logger: Logger;

  private readonly config: ZaloOaAdapterConfig;
  private readonly tokens: ZaloOaTokenManager;
  private readonly api: ZaloOaApiClient;
  private readonly converter = new ZaloOaFormatConverter();
  private readonly fetchImpl: typeof fetch;
  private readonly maxDownloadBytes: number;

  /** Management of the OA's group chats: creation, members, packages. */
  readonly groups: ZaloOaGroups;

  /**
   * Message IDs already dispatched, so a redelivery is not handled twice.
   *
   * Sized for a busy OA: Zalo retries for up to two hours, and a GMF group
   * can have a thousand members, so a thousand entries could be evicted
   * before the last retry of a delivery arrives.
   */
  private readonly seenMessages = new BoundedSet(5000);

  constructor(config: ZaloOaAdapterConfig & { fetchImpl?: typeof fetch }) {
    // The factory validates too, but the class is exported directly. An empty
    // oaSecretKey is the dangerous case: the digest would be computed over a
    // key anyone could guess, and every forged webhook would verify.
    for (const key of REQUIRED_CREDENTIALS) {
      if (!config[key]) {
        throw new ValidationError(ADAPTER_NAME, `Zalo OA ${key} is required.`);
      }
    }

    // Copied so a caller mutating their config object later cannot silently
    // change which account this adapter acts for or which key it trusts.
    this.config = { ...config };
    this.userName = config.userName ?? "zalo-oa-bot";
    this.botUserId = config.oaId;
    this.logger = config.logger ?? new ConsoleLogger();
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxDownloadBytes =
      config.maxDownloadBytes !== undefined && config.maxDownloadBytes > 0
        ? config.maxDownloadBytes
        : DEFAULT_MAX_DOWNLOAD_BYTES;

    this.tokens = new ZaloOaTokenManager({
      appId: config.appId,
      appSecret: config.appSecret,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      accessTokenExpiresAt: config.accessTokenExpiresAt,
      refreshTokenExpiresAt: config.refreshTokenExpiresAt,
      onTokenRefresh: config.onTokenRefresh,
      oauthBaseUrl: config.oauthBaseUrl,
      fetchImpl: config.fetchImpl,
      // A getter, not the value: `initialize()` replaces this.logger with the
      // host's, and the token manager must follow that swap.
      logger: () => this.logger,
    });

    this.api = new ZaloOaApiClient({
      tokens: this.tokens,
      appSecretProof: config.appSecretProof,
      appSecret: config.appSecret,
      baseUrl: config.apiBaseUrl,
      fetchImpl: config.fetchImpl,
      maxRateLimitRetries: config.maxRateLimitRetries,
      rateLimitRetryDelayMs: config.rateLimitRetryDelayMs,
      sleepImpl: config.sleepImpl,
    });

    this.groups = new ZaloOaGroups(this.api, config.oaId, () => this.logger);
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(ADAPTER_NAME);
  }

  // -------------------------------------------------------------------------
  // Thread IDs
  // -------------------------------------------------------------------------

  encodeThreadId(data: ZaloOaThreadId): string {
    return encodeThreadId(data);
  }

  decodeThreadId(threadId: string): ZaloOaThreadId {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).type !== "group";
  }

  /**
   * The thread for a user, for messaging them first.
   *
   * Zalo only lets an OA message a user who interacted with it in the last
   * seven days; outside that window the send fails with a validation error.
   */
  async openDM(userId: string): Promise<string> {
    return this.userThreadId(userId);
  }

  private userThreadId(userId: string): string {
    return this.encodeThreadId({ oaId: this.config.oaId, type: "user", id: userId });
  }

  private groupThreadId(groupId: string): string {
    return this.encodeThreadId({ oaId: this.config.oaId, type: "group", id: groupId });
  }

  private anonymousThreadId(anonymousId: string, conversationId: string): string {
    return this.encodeThreadId({
      oaId: this.config.oaId,
      type: "anonymous",
      id: anonymousId,
      conversationId,
    });
  }

  private threadIdFor(target: ZaloOaThreadId): string {
    switch (target.type) {
      case "group":
        return this.groupThreadId(target.id);
      case "anonymous":
        return this.anonymousThreadId(target.id, target.conversationId ?? "");
      default:
        return this.userThreadId(target.id);
    }
  }

  /** Decode a thread and insist it belongs to this OA. */
  private targetOf(threadId: string): ZaloOaThreadId {
    const target = this.decodeThreadId(threadId);
    if (target.oaId !== this.config.oaId) {
      throw new ValidationError(
        ADAPTER_NAME,
        `This adapter is connected to a different Official Account than ${threadId}.`,
      );
    }
    return target;
  }

  /**
   * Decode a thread and insist it is a conversation with an identified user
   * of this OA, for the operations Zalo offers only there.
   */
  private userIdOf(threadId: string, operation: string): string {
    const { type, id } = this.targetOf(threadId);
    if (type !== "user") {
      throw new NotImplementedError(
        `Zalo offers ${operation} only in conversations with an identified user, not in group chats or with anonymous users`,
        ADAPTER_NAME,
      );
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Handle a webhook delivery.
   *
   * Every authentic delivery is answered 200, including ones this adapter
   * ignores or fails on. Zalo redelivers only when it cannot connect at all,
   * so an error status buys no retry — while Zalo counts it against the
   * webhook and eventually disables it. For the same reason the host's
   * handler is not awaited: Zalo wants an answer within two seconds. Pass
   * `waitUntil` on serverless runtimes so the handler outlives the response.
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    // Read the raw bytes first: the digest covers exactly what was sent, and
    // a parsed-then-re-serialized body will not reproduce it.
    const rawBody = await request.text();

    // The timestamp that the signature covers lives inside the body, so the
    // body has to be read before it can be verified. Parsing untrusted JSON
    // is safe; acting on it before verification is not, and nothing does.
    let event: ZaloOaWebhookEvent;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      // `null` and scalars are valid JSON but not a delivery, and the first
      // would throw on every field read below.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("not an object");
      }
      event = parsed as ZaloOaWebhookEvent;
    } catch {
      this.logger.warn("Rejected a Zalo OA webhook whose body is not a JSON object");
      return new Response("Bad request", { status: 400 });
    }

    const rawTimestamp = (event as { timestamp?: unknown } | null)?.timestamp;
    const verification = verifyWebhookSignature({
      header: request.headers.get(SIGNATURE_HEADER),
      rawBody,
      appId: this.config.appId,
      timestamp:
        typeof rawTimestamp === "string" || typeof rawTimestamp === "number"
          ? String(rawTimestamp)
          : "",
      oaSecretKey: this.config.oaSecretKey,
      toleranceSeconds: this.config.signatureToleranceSeconds,
    });

    if (!verification.valid) {
      if (verification.stale) {
        // Genuine, but too old to act on. Answering an error here would count
        // against the webhook's health without achieving anything.
        this.logger.warn("Dropped a stale Zalo OA webhook", {
          reason: verification.reason,
          event: event.event_name,
        });
        return new Response("OK", { status: 200 });
      }
      this.logger.warn("Rejected Zalo OA webhook", { reason: verification.reason });
      return new Response("Invalid signature", { status: 401 });
    }

    try {
      this.processEvent(event, options);
    } catch (error) {
      this.logger.error("Failed to process Zalo OA webhook", {
        error,
        event: event.event_name,
      });
    }

    return new Response("OK", { status: 200 });
  }

  private processEvent(event: ZaloOaWebhookEvent, options?: WebhookOptions): void {
    const eventName = typeof event.event_name === "string" ? event.event_name : "";

    if (
      isUserMessageEvent(eventName) ||
      isGroupMessageEvent(eventName) ||
      isAnonymousMessageEvent(eventName)
    ) {
      this.dispatchMessage(event, options);
      return;
    }

    if (eventName === "user_reacted_message") {
      this.dispatchReaction(event, options);
      return;
    }

    if (eventName === "user_seen_message") {
      // Not awaited, like a message: Zalo wants its answer within two
      // seconds. The SDK is not involved here, so the task is registered
      // with the host's waitUntil directly, or a serverless runtime could
      // end it with the response.
      const task = this.dispatchReadReceipt(event);
      options?.waitUntil?.(task);
      return;
    }

    // Echoes of what the OA did, through this adapter or an agent using the
    // OA chat tool. Delivering them would make the bot answer itself or a
    // colleague; the history endpoint still returns the messages.
    if (eventName.startsWith("oa_send_") || eventName === "oa_reacted_message") {
      this.logger.debug("Ignoring a Zalo OA echo", { event: eventName });
      return;
    }

    this.logger.debug("Ignoring Zalo OA event", { event: eventName });
  }

  /**
   * The OA an event belongs to.
   *
   * A one-to-one message is addressed to the OA. A group message is
   * addressed to the group and names the OA in `oa_id` instead — so reading
   * the recipient for both would file every group message under another
   * account.
   */
  private ownerOf(event: ZaloOaWebhookEvent): string {
    return isGroupMessageEvent(event.event_name) ? idOf(event.oa_id) : idOf(event.recipient?.id);
  }

  /** The thread a message event belongs to, or `null` when it names no conversation. */
  private inboundTarget(event: ZaloOaWebhookEvent): ZaloOaThreadId | null {
    const senderId = idOf(event.sender?.id);
    if (isGroupMessageEvent(event.event_name)) {
      const groupId = idOf(event.recipient?.id);
      return groupId ? { oaId: this.config.oaId, type: "group", id: groupId } : null;
    }
    if (isAnonymousMessageEvent(event.event_name)) {
      const conversationId = idOf(event.message?.conversation_id);
      return senderId && conversationId
        ? { oaId: this.config.oaId, type: "anonymous", id: senderId, conversationId }
        : null;
    }
    return senderId ? { oaId: this.config.oaId, type: "user", id: senderId } : null;
  }

  private dispatchMessage(event: ZaloOaWebhookEvent, options?: WebhookOptions): void {
    // One app can be linked to several OAs and receives all of their events,
    // so an event for a different OA must not be handled with these tokens.
    // An event naming no OA at all is refused too: failing open here would
    // hand another account's messages to this one.
    if (this.ownerOf(event) !== this.config.oaId) {
      this.logger.warn("Ignoring a Zalo OA webhook for a different Official Account", {
        event: event.event_name,
      });
      return;
    }

    const messageId = messageIdOf(event.message);
    const userId = idOf(event.sender?.id);
    const target = this.inboundTarget(event);
    // All are documented as always present, so an absence means the payload
    // shape changed — worth more than a debug line, since every inbound
    // message would otherwise vanish without a trace in production.
    if (!messageId || !userId || !target) {
      this.logger.warn("Ignoring a Zalo OA message with no ID, sender or conversation", {
        event: event.event_name,
        messageId,
        userId,
      });
      return;
    }

    if (!this.chat) {
      // Zalo will not redeliver after a 200, so this message is lost; error
      // level so a host that binds its route before initialize() notices.
      this.logger.error("Zalo OA adapter received a message before initialize() was called", {
        messageId,
      });
      return;
    }

    // Zalo redelivers when it could not connect, which can still happen after
    // the first attempt was processed — a response lost in transit.
    if (!this.seenMessages.add(messageId)) {
      this.logger.debug("Ignoring duplicate Zalo OA message", { messageId });
      return;
    }

    // Parsed here rather than in a factory handed to the SDK, so a parse
    // failure surfaces in this adapter's log with the event that caused it.
    const message = this.parseMessage(event);

    // Not awaited: see handleWebhook. The SDK attaches its own error handler
    // to this promise and logs a failing handler, and registers it with
    // `waitUntil` when one is given.
    void this.chat.processMessage(this, message.threadId, message, options);
  }

  /**
   * Deliver a user's reaction as a reaction event.
   *
   * Withdrawing a reaction arrives as the icon `/-remove`, which names no
   * emoji. It is delivered as `added: false` with that code as the emoji, so
   * a host learns that the user withdrew a reaction but not which one.
   */
  private dispatchReaction(event: ZaloOaWebhookEvent, options?: WebhookOptions): void {
    if (idOf(event.recipient?.id) !== this.config.oaId) {
      this.logger.warn("Ignoring a Zalo OA webhook for a different Official Account", {
        event: event.event_name,
      });
      return;
    }

    const messageId = messageIdOf(event.message);
    const userId = idOf(event.sender?.id);
    const icon = typeof event.message?.react_icon === "string" ? event.message.react_icon : "";
    if (!messageId || !userId || !icon) {
      this.logger.warn("Ignoring a Zalo OA reaction with no message, sender or icon", {
        messageId,
        userId,
        icon,
      });
      return;
    }

    if (!this.chat) {
      this.logger.error("Zalo OA adapter received a reaction before initialize() was called", {
        messageId,
      });
      return;
    }

    // A reaction has no ID of its own. Its content and send time together
    // identify a delivery, and a redelivery repeats both exactly.
    const key = `reaction:${messageId}:${userId}:${icon}:${idOf(event.timestamp)}`;
    if (!this.seenMessages.add(key)) {
      this.logger.debug("Ignoring duplicate Zalo OA reaction", { messageId });
      return;
    }

    this.chat.processReaction(
      {
        // Optional in the SDK's type but required at runtime: without it the
        // event is dropped before any handler runs.
        adapter: this,
        added: icon !== ZALO_REMOVE_REACTION,
        emoji: fromZaloReactIcon(icon),
        rawEmoji: icon,
        messageId,
        threadId: this.userThreadId(userId),
        user: { userId, userName: userId, fullName: "", isBot: false, isMe: false },
        raw: event,
      },
      options,
    );
  }

  /**
   * Report that a user read messages the OA sent.
   *
   * The OA is the sender here and the user the recipient: the event
   * describes the OA's messages being read. Ownership is therefore checked
   * against the sender.
   */
  private async dispatchReadReceipt(event: ZaloOaWebhookEvent): Promise<void> {
    if (idOf(event.sender?.id) !== this.config.oaId) {
      this.logger.warn("Ignoring a Zalo OA webhook for a different Official Account", {
        event: event.event_name,
      });
      return;
    }

    const userId = idOf(event.recipient?.id);
    const rawIds = event.message?.msg_ids;
    const messageIds = Array.isArray(rawIds) ? rawIds.map(idOf).filter(Boolean) : [];
    const readMs = parseTimestamp(event.timestamp);
    // A receipt is a high-water mark, so an unusable stamp must not degrade
    // to "now": that would mark messages sent after the receipt as read.
    if (!userId || messageIds.length === 0 || readMs === undefined) {
      this.logger.warn("Ignoring a Zalo OA read receipt with no user, messages or time", {
        userId,
        messageIds,
        timestamp: event.timestamp,
      });
      return;
    }

    if (!this.config.onReadReceipt) {
      this.logger.debug("A Zalo OA read receipt arrived but no onReadReceipt is configured", {
        userId,
      });
      return;
    }

    const key = `seen:${userId}:${messageIds.join(",")}:${readMs}`;
    if (!this.seenMessages.add(key)) {
      this.logger.debug("Ignoring duplicate Zalo OA read receipt", { userId });
      return;
    }

    try {
      await this.config.onReadReceipt({
        threadId: this.userThreadId(userId),
        userId,
        messageIds,
        readAt: new Date(readMs),
        raw: event,
      });
    } catch (error) {
      // Zalo does not redeliver on request, so there is nothing to ask for.
      this.logger.error("The onReadReceipt handler failed", { error, userId });
    }
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  parseMessage(raw: ZaloOaRawMessage): Message<ZaloOaRawMessage> {
    if ("event_name" in raw) {
      return this.parseWebhookMessage(raw);
    }
    if ("src" in raw) {
      return this.parseHistoryMessage(raw);
    }
    return this.parseSentMessage(raw);
  }

  private parseWebhookMessage(event: ZaloOaWebhookEvent): Message<ZaloOaRawMessage> {
    const content = event.message ?? {};
    const userId = idOf(event.sender?.id);
    const text = content.text || this.describeAttachments(content.attachments);
    const group = isGroupMessageEvent(event.event_name);
    const target = this.inboundTarget(event);
    if (!target) {
      throw new ValidationError(ADAPTER_NAME, "A Zalo OA message event names no conversation.");
    }

    return new Message<ZaloOaRawMessage>({
      id: messageIdOf(content),
      threadId: this.threadIdFor(target),
      text,
      formatted: this.converter.toAst(text),
      raw: event,
      // Zalo writes a mention as `[@id]`. Only one naming this OA counts:
      // `[@group_id]` addresses everyone, and answering every such broadcast
      // would make the bot reply to announcements. Left unset in one-to-one
      // conversations, where every message is addressed to the bot anyway.
      ...(group ? { isMention: text.includes(`[@${this.config.oaId}]`) } : {}),
      author: {
        // The webhook carries no display name. Hosts that need one can call
        // getUser(), which costs a request — so it is not done per message.
        userId,
        userName: userId,
        fullName: "",
        isBot: false,
        isMe: false,
      },
      metadata: {
        // A live webhook is being handled right now, so receipt time is a
        // sound stand-in for a missing stamp. The warning makes it visible.
        dateSent: new Date(this.timestampOr(event.timestamp, Date.now(), "webhook")),
        edited: false,
      },
      attachments: (content.attachments ?? []).flatMap((attachment) =>
        this.webhookAttachment(attachment),
      ),
    });
  }

  /**
   * Text for a message that has none of its own.
   *
   * A link or a location has nothing to download, so it would otherwise
   * arrive as an empty message: its content is rendered as text instead.
   */
  private describeAttachments(attachments: ZaloOaWebhookAttachment[] | undefined): string {
    const parts: string[] = [];
    for (const attachment of attachments ?? []) {
      const payload = attachment.payload;
      if (attachment.type === "link" && payload?.url) {
        parts.push(payload.url);
      } else if (attachment.type === "location" && payload?.coordinates) {
        parts.push(`[location: ${payload.coordinates.latitude}, ${payload.coordinates.longitude}]`);
      }
    }
    return parts.join("\n");
  }

  private webhookAttachment(attachment: ZaloOaWebhookAttachment): Attachment[] {
    const kind = lookup(ATTACHMENT_KINDS, String(attachment.type));
    const url = attachment.payload?.url;
    if (!kind || !url) {
      return [];
    }

    const size = Number(attachment.payload?.size);
    return [
      {
        type: kind,
        url,
        name: attachment.payload?.name,
        size: Number.isFinite(size) && size > 0 ? size : undefined,
        mimeType:
          attachment.type === "gif"
            ? "image/gif"
            : attachment.type === "file"
              ? mimeTypeForExtension(attachment.payload?.type)
              : undefined,
        fetchData: () => this.download(url),
      },
    ];
  }

  /**
   * Convert an entry from a history endpoint.
   *
   * The history and webhook representations are different shapes, so this
   * cannot reuse the webhook path.
   *
   * `known` is the thread `fetchMessages` read, which it passes in. Deriving
   * the thread from the entry is a last resort: Zalo documents the one-to-one
   * `from_id` and `to_id` as `long`, and an 18-digit ID sent as a JSON number
   * has already lost precision by the time it is parsed — it would decode to
   * a plausible, different user.
   */
  private parseHistoryMessage(
    entry: ZaloOaHistoryMessage,
    fallbackMs = Date.now(),
    known?: Pick<ZaloOaThreadId, "type" | "id">,
  ): Message<ZaloOaRawMessage> {
    // Compared by value: `src` is documented as an int, but a string "1"
    // read strictly would file every user message as the OA's own.
    const fromUser = Number(entry.src) === 1;
    const thread =
      known ??
      (entry.group_id
        ? { type: "group" as const, id: idOf(entry.group_id) }
        : { type: "user" as const, id: idOf(fromUser ? entry.from_id : entry.to_id) });
    if (!thread.id) {
      throw new ValidationError(ADAPTER_NAME, "A Zalo OA history entry names no conversation.");
    }
    // In a group the sender is one member among many, so it is read from the
    // entry; in a one-to-one thread it can only be the thread's user. An
    // unnamed sender is refused rather than given the empty ID that every
    // other unnamed sender would share.
    const userId = thread.type === "group" ? idOf(entry.from_id) : thread.id;
    if (fromUser && !userId) {
      throw new ValidationError(ADAPTER_NAME, "A Zalo OA history entry names no sender.");
    }
    const kind = lookup(HISTORY_ATTACHMENT_KINDS, String(entry.type));
    const url = entry.url;
    const text =
      entry.message ||
      (entry.type === "link" || entry.type === "links" ? (entry.links ?? []).join("\n") : "");

    const author: Author = fromUser
      ? {
          userId,
          userName: userId,
          fullName: entry.from_display_name ?? "",
          isBot: false,
          isMe: false,
        }
      : {
          userId: this.config.oaId,
          userName: this.userName,
          fullName: entry.from_display_name ?? this.userName,
          // Sent by the OA, but whether by this bot or by a person using the
          // OA chat tool is not recorded here.
          isBot: "unknown",
          isMe: true,
        };

    return new Message<ZaloOaRawMessage>({
      id: idOf(entry.message_id),
      threadId:
        thread.type === "group" ? this.groupThreadId(thread.id) : this.userThreadId(thread.id),
      text,
      formatted: this.converter.toAst(text),
      raw: entry,
      author,
      metadata: {
        dateSent: new Date(this.timestampOr(entry.time, fallbackMs, "history")),
        edited: false,
      },
      attachments:
        kind && url
          ? [
              {
                type: kind,
                url,
                mimeType: entry.type === "GIF" ? "image/gif" : undefined,
                fetchData: () => this.download(url),
              },
            ]
          : [],
    });
  }

  private parseSentMessage(data: ZaloOaSendMessageData): Message<ZaloOaRawMessage> {
    return new Message<ZaloOaRawMessage>({
      id: idOf(data.message_id),
      threadId: data.group_id
        ? this.groupThreadId(idOf(data.group_id))
        : data.anonymous_id
          ? this.anonymousThreadId(idOf(data.anonymous_id), idOf(data.conversation_id))
          : this.userThreadId(idOf(data.user_id)),
      text: "",
      formatted: this.converter.toAst(""),
      raw: data,
      author: {
        userId: this.config.oaId,
        userName: this.userName,
        fullName: this.userName,
        isBot: true,
        isMe: true,
      },
      metadata: {
        dateSent: new Date(this.timestampOr(data.sent_time, Date.now(), "send")),
        edited: false,
      },
      attachments: [],
    });
  }

  /**
   * Restore `fetchData` on an attachment that went through serialization.
   *
   * Zalo's media URLs are plain CDN links, so the URL alone is enough.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    const url = attachment.url;
    if (!url || attachment.fetchData) {
      return attachment;
    }
    return { ...attachment, fetchData: () => this.download(url) };
  }

  private async download(url: string): Promise<Buffer> {
    // A persisted attachment's URL is whatever the host stored. Only a web
    // URL can be a Zalo CDN link; anything else would make fetch read a
    // local file or a data: payload on the host's behalf.
    if (!/^https?:\/\//i.test(url)) {
      throw new ValidationError(ADAPTER_NAME, `Refusing to download a non-HTTP URL: ${url}`);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (error) {
      throw new NetworkError(
        ADAPTER_NAME,
        "Downloading a Zalo attachment failed",
        error instanceof Error ? error : undefined,
      );
    }
    if (!response.ok) {
      throw new NetworkError(
        ADAPTER_NAME,
        `Downloading a Zalo attachment failed with HTTP ${response.status}`,
      );
    }

    // Users can send files of up to a gigabyte, and this buffers the whole
    // body. Refused up front when the size is declared, and checked again
    // after reading for a server that does not declare it.
    const declared = Number(response.headers?.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxDownloadBytes) {
      throw this.tooLarge(declared);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.maxDownloadBytes) {
      throw this.tooLarge(bytes.length);
    }
    return bytes;
  }

  private tooLarge(size: number): ValidationError {
    return new ValidationError(
      ADAPTER_NAME,
      `The Zalo attachment is ${size} bytes; the limit is ${this.maxDownloadBytes}. Raise maxDownloadBytes to accept it.`,
    );
  }

  /**
   * A usable epoch-millisecond stamp, or `fallback` with a warning.
   *
   * The warning is the point: a substituted timestamp is invisible
   * downstream, so a renamed or re-typed field would otherwise silently date
   * every message wrong.
   */
  private timestampOr(value: unknown, fallback: number, field: string): number {
    const parsed = parseTimestamp(value);
    if (parsed !== undefined) {
      return parsed;
    }
    this.logger.warn("Zalo sent an unusable timestamp; substituting a fallback", {
      field,
      value,
    });
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send a message.
   *
   * A message may carry one attachment: a JPG or PNG image or a GIF, with
   * optional text shown as its caption, or a PDF, DOC, DOCX or CSV file,
   * which cannot carry text. Several attachments, or text with a file, are
   * refused rather than split into several messages, so the caller decides
   * what gets sent and gets back the one message ID it asked for.
   */
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const target = this.targetOf(threadId);
    const files = extractFiles(message);
    if (files.length === 0) {
      return this.send(threadId, target, { text: this.renderSendableText(message) });
    }
    return this.sendMedia(threadId, target, message, files);
  }

  /**
   * Reply to a specific message, which Zalo shows as a quote. Text only, and
   * one to one only: Zalo's group API has no quoted reply.
   */
  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const userId = this.userIdOf(threadId, "quoted replies");
    if (!messageId) {
      throw new ValidationError(ADAPTER_NAME, "A message ID is required to quote a message.");
    }
    if (extractFiles(message).length > 0) {
      throw new ValidationError(
        ADAPTER_NAME,
        "Zalo quotes only text. Send the attachment as its own message.",
      );
    }
    return this.send(
      threadId,
      { type: "user", id: userId },
      { text: this.renderSendableText(message), quote_message_id: messageId },
    );
  }

  /**
   * Flatten a postable to text Zalo will accept, rejecting what it cannot
   * carry before spending a request.
   */
  private renderSendableText(message: AdapterPostableMessage): string {
    // A card is flattened to text, buttons included, since a consultation
    // message has no interactive form.
    const text = this.converter.renderPostable(message);

    if (!text.trim()) {
      throw new ValidationError(ADAPTER_NAME, "Cannot send an empty message to Zalo.");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Message text is ${text.length} characters; Zalo allows at most ${MAX_TEXT_LENGTH}.`,
      );
    }
    return text;
  }

  /**
   * Upload one attachment and send it.
   *
   * Everything Zalo would refuse is checked before the upload, since each
   * upload spends from a monthly quota.
   */
  private async sendMedia(
    threadId: string,
    target: Pick<ZaloOaThreadId, "type" | "id" | "conversationId">,
    message: AdapterPostableMessage,
    files: FileUpload[],
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    if (files.length > 1) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Zalo sends one attachment per message; got ${files.length}. Send them as separate messages.`,
      );
    }

    const file = files[0] as FileUpload;
    const data = await toBuffer(file.data);
    if (!data) {
      throw new ValidationError(ADAPTER_NAME, `Could not read the attachment "${file.filename}".`);
    }
    const media = prepareMedia(data, file.filename, file.mimeType);

    // Zalo's anonymous endpoint takes an image by URL only, not by the ID an
    // upload returns, so an image in hand cannot be sent there.
    if (target.type === "anonymous" && media.kind !== "file") {
      throw new ValidationError(
        ADAPTER_NAME,
        "Zalo sends an anonymous user images only by URL, not from uploaded bytes. Use sendImageUrl(), or send a file or a sticker.",
      );
    }

    const caption = this.converter.renderPostable(message);
    const hasCaption = caption.trim().length > 0;
    if (media.kind === "file" && hasCaption) {
      throw new ValidationError(
        ADAPTER_NAME,
        "Zalo cannot attach text to a file. Send the text as its own message.",
      );
    }
    if (caption.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(
        ADAPTER_NAME,
        `The caption is ${caption.length} characters; Zalo allows at most ${MAX_TEXT_LENGTH}.`,
      );
    }

    const id = await uploadMedia(this.api, media);

    if (media.kind === "file") {
      return this.send(threadId, target, { attachment: { type: "file", payload: { token: id } } });
    }

    return this.send(threadId, target, {
      // Optional one to one, but required by the group API, which is sent an
      // empty caption rather than refusing an image that has none.
      ...(hasCaption ? { text: caption } : target.type === "group" ? { text: "" } : {}),
      attachment: {
        type: "template",
        payload: {
          template_type: "media",
          elements: [
            media.kind === "gif"
              ? { media_type: "gif", attachment_id: id, width: media.width, height: media.height }
              : { media_type: "image", attachment_id: id },
          ],
        },
      },
    });
  }

  /**
   * Send an image Zalo fetches from a URL, with an optional caption.
   *
   * Every kind of thread accepts this, and for an anonymous user it is the
   * only way to send an image at all: that endpoint takes no uploaded
   * attachment. Zalo wants a public JPG or PNG of at most 1 MB.
   */
  async sendImageUrl(
    threadId: string,
    url: string,
    caption?: string,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const target = this.targetOf(threadId);
    if (!/^https?:\/\//i.test(String(url ?? ""))) {
      throw new ValidationError(ADAPTER_NAME, `An image URL must be http or https; got "${url}".`);
    }
    const text = caption ?? "";
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(
        ADAPTER_NAME,
        `The caption is ${text.length} characters; Zalo allows at most ${MAX_TEXT_LENGTH}.`,
      );
    }
    return this.send(threadId, target, {
      ...(text.trim() ? { text } : target.type === "group" ? { text: "" } : {}),
      attachment: {
        type: "template",
        payload: { template_type: "media", elements: [{ media_type: "image", url }] },
      },
    });
  }

  /**
   * Send a sticker.
   *
   * Chat SDK has no sticker concept, so this is its own method. Zalo offers
   * no API to list stickers: IDs come from stickers.zaloapp.com, or from a
   * sticker a user sent, via {@link getStickerId}.
   */
  async sendSticker(threadId: string, stickerId: string): Promise<RawMessage<ZaloOaRawMessage>> {
    const target = this.targetOf(threadId);
    // Coerced like every other caller-supplied ID: `getStickerId()` can
    // return `undefined`, and passing that straight through must fail as a
    // validation error, not a TypeError.
    const id = String(stickerId ?? "").trim();
    if (!id) {
      throw new ValidationError(ADAPTER_NAME, "A sticker ID is required to send a sticker.");
    }
    return this.send(threadId, target, {
      attachment: {
        type: "template",
        payload: {
          template_type: "media",
          elements: [{ media_type: "sticker", attachment_id: id }],
        },
      },
    });
  }

  private async send(
    threadId: string,
    target: Pick<ZaloOaThreadId, "type" | "id" | "conversationId">,
    message: ZaloOaOutboundMessage,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const data = await this.api.request<ZaloOaSendMessageData>(
      target.type === "group"
        ? {
            method: "POST",
            path: "v3.0/oa/group/message",
            body: { recipient: { group_id: target.id }, message },
          }
        : target.type === "anonymous"
          ? {
              method: "POST",
              path: "v2.0/oa/message",
              body: {
                recipient: { anonymous_id: target.id, conversation_id: target.conversationId },
                message,
              },
            }
          : {
              method: "POST",
              path: "v3.0/oa/message/cs",
              body: { recipient: { user_id: target.id }, message },
            },
    );
    return this.sentMessage(threadId, data);
  }

  private sentMessage(threadId: string, data: ZaloOaSendMessageData): RawMessage<ZaloOaRawMessage> {
    const messageId = idOf(data?.message_id);
    if (!messageId) {
      // Success with no ID means delivery is unconfirmed, and the host has
      // nothing to quote, edit, or correlate with a later read receipt.
      throw new NetworkError(
        ADAPTER_NAME,
        "Zalo accepted the send but returned no message_id, so delivery is unconfirmed.",
      );
    }

    return { id: messageId, raw: data, threadId };
  }

  /**
   * Send a ZBS template message.
   *
   * The template is registered and approved at Zalo in advance; a send only
   * names it and fills in its parameters. Unlike a consultation message it
   * reaches a user outside the seven-day interaction window, which is what it
   * is for — and unlike one, it is charged per message. Zalo sends templates
   * by user only, so a group thread is refused.
   */
  async sendTemplate(
    threadId: string,
    templateId: string | number,
    data: ZaloOaTemplateData,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const userId = this.userIdOf(threadId, "template messages");
    // `listTemplates()` reports IDs as numbers, so both spellings are taken.
    const id = idOf(templateId).trim();
    if (!id) {
      throw new ValidationError(ADAPTER_NAME, "A template ID is required to send a template.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ValidationError(
        ADAPTER_NAME,
        "Template data must be an object of parameter values.",
      );
    }

    const sent = await this.api.request<ZaloOaSendMessageData>({
      method: "POST",
      path: "v3.0/oa/message/template",
      body: { user_id: userId, template_id: id, template_data: data },
    });
    return this.sentMessage(threadId, sent);
  }

  /**
   * Send a ZBS template to a phone number.
   *
   * The way to reach someone who has never interacted with the OA, and the
   * only way to send OTP templates and templates created before 10 December
   * 2025. The number must be linked to a Zalo account and written with its
   * country code. Charged per message, against a daily quota Zalo adjusts
   * to the OA's sending quality. Requires the "send messages by phone
   * number" permission.
   *
   * A phone send belongs to no thread, so this returns Zalo's receipt
   * rather than a message.
   */
  async sendTemplateByPhone(
    phone: string,
    templateId: string | number,
    data: ZaloOaTemplateData,
    options?: {
      /**
       * Your own ID for reconciling this send, at most 48 characters of
       * letters, digits, `_` and `-`. Generated when omitted.
       */
      trackingId?: string;
      /** `3` sends past the daily quota; whitelisted OAs only. */
      sendingMode?: 1 | 3;
    },
  ): Promise<ZaloOaPhoneTemplateResult> {
    const number = String(phone ?? "").replace(/[\s().-]/g, "");
    if (!PHONE.test(number)) {
      throw new ValidationError(
        ADAPTER_NAME,
        `"${phone}" is not a phone number in international form, such as 84987654321.`,
      );
    }
    const id = idOf(templateId).trim();
    if (!id) {
      throw new ValidationError(ADAPTER_NAME, "A template ID is required to send a template.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ValidationError(
        ADAPTER_NAME,
        "Template data must be an object of parameter values.",
      );
    }
    const trackingId = options?.trackingId ?? crypto.randomUUID().replaceAll("-", "");
    if (!TRACKING_ID.test(trackingId)) {
      throw new ValidationError(
        ADAPTER_NAME,
        `"${trackingId}" is not a valid tracking ID: at most 48 letters, digits, _ or -.`,
      );
    }

    const sent = await this.api.request<ZaloOaPhoneTemplateData>({
      method: "POST",
      baseUrl: this.config.businessApiBaseUrl ?? ZALO_BUSINESS_API_HOST,
      path: "message/template",
      body: {
        phone: number.replace(/^\+/, ""),
        template_id: id,
        template_data: data,
        tracking_id: trackingId,
        ...(options?.sendingMode !== undefined
          ? { sending_mode: String(options.sendingMode) }
          : {}),
      },
    });

    const messageId = idOf(sent?.msg_id);
    if (!messageId) {
      throw new NetworkError(
        ADAPTER_NAME,
        "Zalo accepted the template but returned no msg_id, so delivery is unconfirmed.",
      );
    }
    const sentMs = parseTimestamp(sent.sent_time);
    const remaining = Number(sent.quota?.remainingQuota);
    return {
      messageId,
      trackingId,
      sentAt: sentMs === undefined ? undefined : new Date(sentMs),
      remainingDailyQuota: Number.isFinite(remaining) ? remaining : undefined,
      raw: sent,
    };
  }

  /**
   * List the OA's ZBS templates, newest first, with the count across pages.
   *
   * Requires the "manage message templates" permission.
   */
  async listTemplates(options?: {
    offset?: number;
    /** At most 100, which is also the default. */
    limit?: number;
    status?: ZaloOaTemplateStatus;
  }): Promise<{ templates: ZaloOaTemplateSummary[]; total: number }> {
    const offset = Math.trunc(options?.offset ?? 0);
    const limit = Math.trunc(options?.limit ?? TEMPLATE_PAGE_LIMIT);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new ValidationError(ADAPTER_NAME, `Invalid template offset: ${options?.offset}`);
    }
    if (!Number.isFinite(limit) || limit < 1 || limit > TEMPLATE_PAGE_LIMIT) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Template limit must be between 1 and ${TEMPLATE_PAGE_LIMIT}; got ${options?.limit}.`,
      );
    }
    const status = options?.status;
    const statusCode = status === undefined ? undefined : lookup(TEMPLATE_STATUS_CODES, status);
    if (status !== undefined && statusCode === undefined) {
      throw new ValidationError(ADAPTER_NAME, `Unknown template status: ${status}`);
    }

    const envelope = await this.api.requestEnvelope<ZaloOaTemplateSummary[]>({
      method: "GET",
      baseUrl: this.config.businessApiBaseUrl ?? ZALO_BUSINESS_API_HOST,
      path: "template/all",
      query: { offset, limit, status: statusCode },
    });
    const templates = Array.isArray(envelope.data) ? envelope.data : [];
    const total = Number(envelope.metadata?.total);
    return { templates, total: Number.isFinite(total) ? total : templates.length };
  }

  /** Zalo OA has no typing indicator, so this does nothing. */
  async startTyping(_threadId: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  /**
   * Fetch messages, newest page first.
   *
   * Zalo pages backward from the most recent message by offset, ten at a
   * time, so the cursor is that offset and only `backward` is supported.
   * Messages within the page are returned oldest first.
   */
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<ZaloOaRawMessage>> {
    const target = this.targetOf(threadId);

    if (target.type === "anonymous") {
      throw new NotImplementedError(
        "Zalo keeps no readable history for anonymous conversations",
        ADAPTER_NAME,
      );
    }

    if (options?.direction === "forward") {
      throw new NotImplementedError(
        "Zalo OA history can only be read backward from the newest message",
        ADAPTER_NAME,
      );
    }

    // Digits only: `Number("")` and `Number(" 5 ")` are integers too, and an
    // empty cursor read as zero would silently restart from the newest page.
    const cursor = options?.cursor;
    if (cursor !== undefined && !/^\d+$/.test(cursor)) {
      throw new ValidationError(ADAPTER_NAME, `Invalid Zalo OA history cursor: ${cursor}`);
    }
    const start = cursor === undefined ? 0 : Number(cursor);

    // A NaN limit would skip the loop yet return a cursor, so a caller paging
    // until the cursor runs out would never stop. A fraction would be sent to
    // Zalo as a fractional count.
    const requested = options?.limit ?? HISTORY_PAGE_SIZE;
    if (!Number.isFinite(requested)) {
      throw new ValidationError(ADAPTER_NAME, `Invalid Zalo OA history limit: ${requested}`);
    }
    const limit = Math.trunc(requested);

    // `limit: 0` means none. Testing truthiness would fetch a page, the
    // opposite of what the caller asked for.
    if (limit <= 0) {
      return { messages: [], nextCursor: options?.cursor };
    }

    const pageSize = target.type === "group" ? GROUP_HISTORY_PAGE_SIZE : HISTORY_PAGE_SIZE;
    const entries: ZaloOaHistoryMessage[] = [];
    let offset = start;
    let exhausted = false;

    while (entries.length < limit) {
      const count = Math.min(pageSize, limit - entries.length);
      // Sequential by definition: each page starts where the last ended.
      // The two endpoints take their parameters differently: one-to-one
      // history wants a JSON `data` parameter, group history plain ones.
      // oxlint-disable-next-line no-await-in-loop
      const page = await this.api.request<ZaloOaHistoryMessage[]>(
        target.type === "group"
          ? {
              method: "GET",
              path: "v3.0/oa/group/conversation",
              query: { group_id: target.id, offset, count },
            }
          : {
              method: "GET",
              path: "v2.0/oa/conversation",
              query: { data: JSON.stringify({ user_id: target.id, offset, count }) },
            },
      );

      const items = Array.isArray(page) ? page : [];
      entries.push(...items);
      offset += items.length;

      if (items.length < count) {
        exhausted = true;
        break;
      }
    }

    const messages: Array<Message<ZaloOaRawMessage>> = [];
    // An entry with no usable stamp inherits its newer neighbour's, which
    // keeps it in place when sorted instead of jumping to "now".
    let lastKnownMs = Date.now();
    for (const entry of entries) {
      // Per entry: one unreadable entry should not discard the page.
      try {
        const parsed = this.parseHistoryMessage(entry, lastKnownMs, target);
        lastKnownMs = parsed.metadata.dateSent.getTime();
        messages.push(parsed);
      } catch (error) {
        this.logger.warn("Skipping an unreadable Zalo OA history entry", { error });
      }
    }

    // Zalo returns newest first; the SDK wants each page in reading order.
    // Reversed first so messages sharing a timestamp keep their true order
    // under the stable sort, then sorted, since the order Zalo describes is
    // not one it promises.
    messages.reverse();
    messages.sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());

    return { messages, nextCursor: exhausted ? undefined : String(offset) };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { type } = this.targetOf(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: type !== "group",
      metadata: {},
    };
  }

  /** The channel is the Official Account itself. */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const oaId = decodeChannelId(channelId);
    // Without this guard, a multi-tenant host that passes tenant B's channel
    // to tenant A's adapter gets A's profile back, labelled as B's.
    if (oaId !== this.config.oaId) {
      throw new ValidationError(
        ADAPTER_NAME,
        `This adapter is connected to a different Official Account than ${channelId}.`,
      );
    }

    const info = await this.api.request<ZaloOaInfo>({ method: "GET", path: "v2.0/oa/getoa" });

    return {
      id: channelId,
      name: info.name,
      metadata: {
        alias: info.oa_alias,
        avatar: info.avatar,
        isVerified: info.is_verified,
        followers: info.num_follower,
        packageName: info.package_name,
      },
    };
  }

  /** Look up a user's profile. Requires the "manage user information" permission. */
  async getUser(userId: string): Promise<UserInfo | null> {
    const detail = await this.api.request<ZaloOaUserDetail>({
      method: "GET",
      path: "v3.0/oa/user/detail",
      query: { data: JSON.stringify({ user_id: userId }) },
    });

    return {
      userId: detail.user_id ?? userId,
      userName: detail.user_alias || detail.display_name || userId,
      fullName: detail.display_name ?? "",
      isBot: false,
      avatarUrl: detail.avatar,
    };
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  /**
   * React to a message.
   *
   * Zalo offers a fixed set: thumbs_up, heart, laugh, surprised, cry, angry,
   * and `--b`, which has no documented meaning and can be sent only by its
   * code. Anything else is refused rather than approximated.
   */
  async addReaction(
    threadId: string,
    messageId: string,
    value: EmojiValue | string,
  ): Promise<void> {
    await this.react(threadId, messageId, this.reactIconFor(value));
  }

  /**
   * Withdraw the OA's reaction from a message.
   *
   * Zalo's withdrawal names no emoji, so this removes whatever the OA had
   * placed, not only `value`. The emoji is still checked, so a typo fails
   * instead of silently removing a reaction.
   */
  async removeReaction(
    threadId: string,
    messageId: string,
    value: EmojiValue | string,
  ): Promise<void> {
    this.reactIconFor(value);
    await this.react(threadId, messageId, ZALO_REMOVE_REACTION);
  }

  private reactIconFor(value: EmojiValue | string): string {
    const icon = toZaloReactIcon(value);
    if (!icon) {
      const name = typeof value === "string" ? value : value.name;
      throw new ValidationError(
        ADAPTER_NAME,
        `Zalo has no "${name}" reaction. It offers: ${supportedReactions()}.`,
      );
    }
    return icon;
  }

  private async react(threadId: string, messageId: string, icon: string): Promise<void> {
    const userId = this.userIdOf(threadId, "reactions");
    if (!messageId) {
      throw new ValidationError(ADAPTER_NAME, "A message ID is required to react to a message.");
    }
    await this.api.request({
      method: "POST",
      path: "v2.0/oa/message",
      body: {
        recipient: { user_id: userId },
        sender_action: { react_icon: icon, react_message_id: messageId },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Unsupported
  //
  // Chat SDK requires these methods. They throw so a caller finds out
  // immediately, instead of believing an edit was recorded.
  // -------------------------------------------------------------------------

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    return Promise.reject(
      new NotImplementedError("Zalo OA does not support editing messages", ADAPTER_NAME),
    );
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    return Promise.reject(
      new NotImplementedError("Zalo OA does not support deleting messages", ADAPTER_NAME),
    );
  }
}
