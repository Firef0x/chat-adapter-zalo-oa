import type { Logger } from "chat";

// ---------------------------------------------------------------------------
// Thread IDs
// ---------------------------------------------------------------------------

/**
 * Who a thread talks to.
 *
 * `group` is reserved for Zalo's GMF group chats. It is part of the thread ID
 * from the start so that adding group support later cannot change the shape
 * of IDs a host has already persisted.
 */
export type ZaloOaThreadType = "user" | "group";

export interface ZaloOaThreadId {
  /** The Official Account that owns the conversation. */
  oaId: string;
  type: ZaloOaThreadType;
  /** The OA-scoped user ID for `user`, or the group ID for `group`. */
  id: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ZaloOaTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
  /** Epoch milliseconds. */
  refreshTokenExpiresAt: number;
}

export interface ZaloOaAdapterConfig {
  /** The Zalo app ID, from the app's page on developers.zalo.me. */
  appId: string;
  /**
   * The app's secret key.
   *
   * Used only to refresh the access token. It is a different value from
   * {@link oaSecretKey}, which signs webhooks.
   */
  appSecret: string;
  /**
   * The OA secret key shown in the app's Webhook settings.
   *
   * Zalo signs every webhook with this key, not with the app secret.
   */
  oaSecretKey: string;
  /** The Official Account this adapter acts for. */
  oaId: string;
  accessToken: string;
  /**
   * Single-use: Zalo invalidates it on every refresh and issues a new one, so
   * the host must persist what {@link onTokenRefresh} hands back.
   */
  refreshToken: string;
  /** Epoch milliseconds. Unknown is treated as expired, forcing one refresh. */
  accessTokenExpiresAt?: number;
  /** Epoch milliseconds. Defaults to never, since the refresh call will say. */
  refreshTokenExpiresAt?: number;
  /**
   * Called after every successful refresh.
   *
   * Persist the tokens here. The old refresh token stops working the moment
   * this is called, so a host that drops these loses the connection on its
   * next restart.
   */
  onTokenRefresh?: (tokens: ZaloOaTokens) => void | Promise<void>;
  /** Display name for the bot. Defaults to `"zalo-oa-bot"`. */
  userName?: string;
  logger?: Logger;
  /**
   * How old a signed webhook may be before it is dropped, in seconds.
   *
   * Defaults to 7200. Zalo redelivers a failed event with its original
   * timestamp for up to about 1 hour 51 minutes, so a tighter window throws
   * away exactly the retries meant to recover an outage.
   */
  signatureToleranceSeconds?: number;
  /**
   * Largest attachment `fetchData()` will buffer, in bytes. Defaults to
   * 50 MiB. Zalo users can send files of up to a gigabyte.
   */
  maxDownloadBytes?: number;
  /**
   * Host of the ZBS template management API. Defaults to
   * `https://business.openapi.zalo.me`.
   */
  businessApiBaseUrl?: string;
  /** Defaults to `https://openapi.zalo.me`. */
  apiBaseUrl?: string;
  /** Defaults to `https://oauth.zaloapp.com`. */
  oauthBaseUrl?: string;
  /** How many times to retry a throttled request. Defaults to 2. */
  maxRateLimitRetries?: number;
  /** Delay before the first throttling retry, in milliseconds. Defaults to 1000. */
  rateLimitRetryDelayMs?: number;
  /** Injectable delay, for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// REST envelopes and error codes
// ---------------------------------------------------------------------------

/** Every Open API response. A failure arrives as HTTP 200 with a non-zero `error`. */
export interface ZaloOaApiEnvelope<TData> {
  error: number;
  message: string;
  data: TData;
}

/**
 * Error codes this adapter treats specially.
 *
 * The full table is at docs.zaloplatforms.com/docs/OA/phu-luc/ma-loi.
 */
export const ZALO_OA_ERROR = {
  OK: 0,
  RATE_LIMITED: -32,
  ATTACHMENT_EXPIRED: -100,
  SEND_FAILED: -200,
  INVALID_PARAM: -201,
  OA_DISABLED: -204,
  OA_NOT_FOUND: -205,
  APP_NOT_ACTIVATED: -209,
  PARAM_OUT_OF_RANGE: -210,
  OUT_OF_QUOTA: -211,
  API_NOT_REGISTERED: -212,
  USER_NOT_FOLLOWER: -213,
  INVALID_ACCESS_TOKEN: -216,
  USER_QUOTA_EXCEEDED: -218,
  APP_DISABLED: -219,
  ACCESS_TOKEN_EXPIRED: -220,
  OA_NOT_VERIFIED: -221,
  API_NOT_AUTHORIZED: -223,
  PACKAGE_REQUIRED: -224,
  USER_UNREACHABLE: -227,
  NO_RECENT_INTERACTION: -230,
  INTERACTION_EXPIRED: -232,
  UNSUPPORTED_MESSAGE_TYPE: -233,
  QUIET_HOURS: -234,
  UNSUPPORTED_OA_TYPE: -235,
  INVALID_APPSECRET_PROOF: -242,
  USER_RESTRICTED: -244,
  POLICY_VIOLATION: -248,
  GROUP_DISABLED: -237,
  TEMPLATE_NOT_SENDABLE_BY_UID: -249,
  CLOUD_ACCOUNT_REQUIRED: -320,
  CLOUD_ACCOUNT_UNPAID: -321,
  OA_NOT_IN_GROUP: -403,
} as const;

export type ZaloOaErrorCode = (typeof ZALO_OA_ERROR)[keyof typeof ZALO_OA_ERROR];

/**
 * The OAuth token endpoint's response.
 *
 * Success carries the three token fields. Failure carries `error` and a
 * description instead, with HTTP 200 — so success is recognized by content,
 * never by status.
 */
export interface ZaloOaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Seconds, as a string: `"90000"`. */
  expires_in?: string | number;
  error?: number;
  error_name?: string;
  error_reason?: string;
  error_description?: string;
}

/**
 * `data` of a send: `POST /v3.0/oa/message/cs` and `/message/template` name
 * the user, `POST /v3.0/oa/group/message` names the group.
 */
export interface ZaloOaSendMessageData {
  message_id: string;
  user_id?: string;
  group_id?: string;
  /** Epoch milliseconds, as a string. */
  sent_time?: string;
  quota?: {
    quota_type: string;
    remain?: string;
    total?: string;
    expired_date?: string;
    owner_type?: string;
    owner_id?: string;
  };
}

/** One element of a `media` template: an image, GIF or sticker. */
export type ZaloOaMediaElement =
  | { media_type: "image"; attachment_id: string }
  | { media_type: "gif"; attachment_id: string; width?: number; height?: number }
  | { media_type: "sticker"; attachment_id: string };

/** The `message` of `POST /v3.0/oa/message/cs`. */
export interface ZaloOaOutboundMessage {
  /** Up to 2,000 characters. With a media template, the caption. */
  text?: string;
  quote_message_id?: string;
  attachment?:
    | {
        type: "template";
        payload: { template_type: "media"; elements: [ZaloOaMediaElement] };
      }
    | { type: "file"; payload: { token: string } };
}

/** `data` of `GET /v2.0/oa/getoa`. */
export interface ZaloOaInfo {
  oa_id?: string | number;
  /** The example response spells it this way; the field table says `oa_id`. */
  oaid?: string | number;
  name: string;
  description?: string;
  oa_alias?: string;
  is_verified?: boolean;
  avatar?: string;
  cover?: string;
  num_follower?: number;
  package_name?: string;
}

/** `data` of `GET /v3.0/oa/user/detail`. */
export interface ZaloOaUserDetail {
  user_id: string;
  user_id_by_app?: string;
  display_name?: string;
  user_alias?: string;
  user_is_follower?: boolean;
  avatar?: string;
  avatars?: Record<string, string>;
  /** `dd/MM/yyyy`. */
  user_last_interaction_date?: string;
}

/** One entry of `GET /v2.0/oa/conversation`. */
export interface ZaloOaHistoryMessage {
  message_id: string;
  /** 0: OA to user. 1: user to OA. */
  src: 0 | 1;
  /** Epoch milliseconds. */
  time: number;
  type: "text" | "voice" | "photo" | "GIF" | "link" | "links" | "sticker" | "location" | string;
  message?: string;
  links?: string[];
  thumb?: string;
  url?: string;
  description?: string;
  from_id: string | number;
  to_id: string | number;
  from_display_name?: string;
  from_avatar?: string;
  to_display_name?: string;
  to_avatar?: string;
  location?: string;
  /** Set on entries of a group conversation. */
  group_id?: string;
}

/** Values for a ZBS template's parameters, as registered with Zalo. */
export type ZaloOaTemplateData = Record<string, string | number>;

export type ZaloOaTemplateStatus = "ENABLE" | "PENDING_REVIEW" | "REJECT" | "DISABLE";

/** One entry of `GET business.openapi.zalo.me/template/all`. */
export interface ZaloOaTemplateSummary {
  templateId: string | number;
  templateName: string;
  createdTime?: number;
  status: ZaloOaTemplateStatus | string;
  /** `HIGH`, `MEDIUM`, `LOW` or `UNDEFINED`. A `LOW` template may be locked. */
  templateQuality?: string;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** One-to-one message events from the user. */
export type ZaloOaUserMessageEventName =
  | "user_send_text"
  | "user_send_image"
  | "user_send_gif"
  | "user_send_link"
  | "user_send_audio"
  | "user_send_video"
  | "user_send_sticker"
  | "user_send_location"
  | "user_send_business_card"
  | "user_send_file";

export interface ZaloOaWebhookAttachmentPayload {
  url?: string;
  thumbnail?: string;
  description?: string;
  /** Sticker ID. */
  id?: string;
  /** File size in bytes, as a string. */
  size?: string;
  name?: string;
  checksum?: string;
  /** File extension, e.g. `"docx"`. */
  type?: string;
  coordinates?: { latitude: string; longitude: string };
}

export interface ZaloOaWebhookAttachment {
  type: "image" | "gif" | "link" | "audio" | "video" | "sticker" | "location" | "file" | string;
  payload?: ZaloOaWebhookAttachmentPayload;
}

export interface ZaloOaWebhookMessage {
  msg_id?: string;
  /** Group events' field table names it this; their example uses `msg_id`. */
  message_id?: string;
  text?: string;
  /** Set on `user_reacted_message`: the icon code, or `/-remove` for a withdrawal. */
  react_icon?: string;
  /** Present when the user replied to a specific message. */
  quote_msg_id?: string;
  attachments?: ZaloOaWebhookAttachment[];
}

/**
 * A webhook delivery.
 *
 * For a user message, `sender.id` is the user and `recipient.id` the OA. For
 * an `oa_send_*` echo the two are swapped.
 */
export interface ZaloOaWebhookEvent {
  app_id: string;
  event_name: string;
  sender: { id: string; admin_id?: string };
  recipient: { id: string };
  message?: ZaloOaWebhookMessage;
  /** Epoch milliseconds, as a string. Also part of the signature. */
  timestamp: string;
  user_id_by_app?: string;
  /** Set on group events, whose recipient is the group rather than the OA. */
  oa_id?: string;
}

/** What `parseMessage` accepts: a live delivery or a history entry. */
export type ZaloOaRawMessage = ZaloOaWebhookEvent | ZaloOaHistoryMessage | ZaloOaSendMessageData;
