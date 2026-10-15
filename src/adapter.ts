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
  FormattedContent,
  Logger,
  RawMessage,
  ThreadInfo,
  UserInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";

import { ZaloOaApiClient } from "./lib/api-client.js";
import { BoundedSet } from "./lib/bounded-set.js";
import { ZaloOaFormatConverter } from "./lib/format-converter.js";
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
  ZaloOaRawMessage,
  ZaloOaSendMessageData,
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

/** The history endpoint returns at most this many messages per request. */
const HISTORY_PAGE_SIZE = 10;

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

/** One-to-one user message events. Group events carry `_group_` and are not handled yet. */
function isUserMessageEvent(eventName: string): boolean {
  return eventName.startsWith("user_send_") && !eventName.startsWith("user_send_group_");
}

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

  /** Message IDs already dispatched, so a redelivery is not handled twice. */
  private readonly seenMessages = new BoundedSet(1000);

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
      baseUrl: config.apiBaseUrl,
      fetchImpl: config.fetchImpl,
      maxRateLimitRetries: config.maxRateLimitRetries,
      rateLimitRetryDelayMs: config.rateLimitRetryDelayMs,
      sleepImpl: config.sleepImpl,
    });
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
    return this.decodeThreadId(threadId).type === "user";
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

  /** Decode a thread and insist it is a one-to-one conversation of this OA. */
  private userIdOf(threadId: string): string {
    const { oaId, type, id } = this.decodeThreadId(threadId);
    if (oaId !== this.config.oaId) {
      throw new ValidationError(
        ADAPTER_NAME,
        `This adapter is connected to a different Official Account than ${threadId}.`,
      );
    }
    if (type !== "user") {
      throw new NotImplementedError("Zalo OA group chats are not supported yet", ADAPTER_NAME);
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
      event = JSON.parse(rawBody) as ZaloOaWebhookEvent;
    } catch {
      this.logger.warn("Rejected a Zalo OA webhook whose body is not JSON");
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
          event: event?.event_name,
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

    if (isUserMessageEvent(eventName)) {
      this.dispatchUserMessage(event, options);
      return;
    }

    // Echoes of messages the OA sent, through this adapter or an agent typing
    // in the OA chat tool. Delivering them would make the bot answer itself
    // or a colleague; the history endpoint still returns them.
    if (eventName.startsWith("oa_send_")) {
      this.logger.debug("Ignoring a Zalo OA echo", { event: eventName });
      return;
    }

    this.logger.debug("Ignoring Zalo OA event", { event: eventName });
  }

  private dispatchUserMessage(event: ZaloOaWebhookEvent, options?: WebhookOptions): void {
    // One app can be linked to several OAs and receives all of their events,
    // so an event for a different OA must not be handled with these tokens.
    if (idOf(event.recipient?.id) !== this.config.oaId) {
      this.logger.warn("Ignoring a Zalo OA webhook for a different Official Account", {
        event: event.event_name,
      });
      return;
    }

    const messageId = idOf(event.message?.msg_id);
    const userId = idOf(event.sender?.id);
    // Both are documented as always present, so an absence means the payload
    // shape changed — worth more than a debug line, since every inbound
    // message would otherwise vanish without a trace in production.
    if (!messageId || !userId) {
      this.logger.warn("Ignoring a Zalo OA message with no ID or sender", {
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
    void this.chat.processMessage(this, this.userThreadId(userId), message, options);
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

    return new Message<ZaloOaRawMessage>({
      id: idOf(content.msg_id),
      threadId: this.userThreadId(userId),
      text,
      formatted: this.converter.toAst(text),
      raw: event,
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
    const kind = ATTACHMENT_KINDS[attachment.type];
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
        mimeType: attachment.type === "gif" ? "image/gif" : undefined,
        fetchData: () => this.download(url),
      },
    ];
  }

  /**
   * Convert an entry from the history endpoint.
   *
   * The history and webhook representations are different shapes, so this
   * cannot reuse the webhook path.
   *
   * `userId` is passed in by `fetchMessages`, which already knows whose
   * conversation it read. Deriving it from the entry is a last resort: Zalo
   * documents `from_id` and `to_id` as `long`, and an 18-digit ID sent as a
   * JSON number has already lost precision by the time it is parsed — it
   * would decode to a plausible, different user.
   */
  private parseHistoryMessage(
    entry: ZaloOaHistoryMessage,
    fallbackMs = Date.now(),
    knownUserId?: string,
  ): Message<ZaloOaRawMessage> {
    // Compared by value: `src` is documented as an int, but a string "1"
    // read strictly would file every user message as the OA's own.
    const fromUser = Number(entry.src) === 1;
    const userId = knownUserId ?? idOf(fromUser ? entry.from_id : entry.to_id);
    if (!userId) {
      throw new ValidationError(ADAPTER_NAME, "A Zalo OA history entry names no user.");
    }
    const kind = HISTORY_ATTACHMENT_KINDS[entry.type];
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
      id: entry.message_id,
      threadId: this.userThreadId(userId),
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
      id: data.message_id,
      threadId: this.userThreadId(data.user_id),
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

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const userId = this.userIdOf(threadId);
    return this.send(threadId, userId, { text: this.renderSendableText(message) });
  }

  /** Reply to a specific message, which Zalo shows as a quote. */
  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const userId = this.userIdOf(threadId);
    if (!messageId) {
      throw new ValidationError(ADAPTER_NAME, "A message ID is required to quote a message.");
    }
    return this.send(threadId, userId, {
      text: this.renderSendableText(message),
      quote_message_id: messageId,
    });
  }

  /**
   * Flatten a postable to text Zalo will accept, rejecting what it cannot
   * carry before spending a request.
   */
  private renderSendableText(message: AdapterPostableMessage): string {
    if (extractFiles(message).length > 0) {
      throw new NotImplementedError(
        "Sending attachments through Zalo OA is not supported yet",
        ADAPTER_NAME,
      );
    }

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

  private async send(
    threadId: string,
    userId: string,
    message: { text: string; quote_message_id?: string },
  ): Promise<RawMessage<ZaloOaRawMessage>> {
    const data = await this.api.request<ZaloOaSendMessageData>({
      method: "POST",
      path: "v3.0/oa/message/cs",
      body: { recipient: { user_id: userId }, message },
    });

    if (!data?.message_id) {
      // Success with no ID means delivery is unconfirmed, and the host has
      // nothing to quote, edit, or correlate with a later read receipt.
      throw new NetworkError(
        ADAPTER_NAME,
        "Zalo accepted the send but returned no message_id, so delivery is unconfirmed.",
      );
    }

    return { id: data.message_id, raw: data, threadId };
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
    const userId = this.userIdOf(threadId);

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

    const entries: ZaloOaHistoryMessage[] = [];
    let offset = start;
    let exhausted = false;

    while (entries.length < limit) {
      const count = Math.min(HISTORY_PAGE_SIZE, limit - entries.length);
      // Sequential by definition: each page starts where the last ended.
      // oxlint-disable-next-line no-await-in-loop
      const page = await this.api.request<ZaloOaHistoryMessage[]>({
        method: "GET",
        path: "v2.0/oa/conversation",
        query: { data: JSON.stringify({ user_id: userId, offset, count }) },
      });

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
        const parsed = this.parseHistoryMessage(entry, lastKnownMs, userId);
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
    const { type } = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: type === "user",
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
  // Unsupported
  //
  // Chat SDK requires these methods. They throw so a caller finds out
  // immediately, instead of believing an edit or reaction was recorded.
  // -------------------------------------------------------------------------

  addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    return Promise.reject(
      new NotImplementedError("Zalo OA reactions are not supported yet", ADAPTER_NAME),
    );
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    return Promise.reject(
      new NotImplementedError("Zalo OA reactions are not supported yet", ADAPTER_NAME),
    );
  }

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
