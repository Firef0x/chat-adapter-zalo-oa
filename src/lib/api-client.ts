import crypto from "node:crypto";

import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ValidationError,
} from "@chat-adapter/shared";

import type { ZaloOaApiEnvelope } from "../types.js";
import { ZALO_OA_ERROR } from "../types.js";
import { ADAPTER_NAME } from "./thread-id.js";

export const ZALO_OA_API_HOST = "https://openapi.zalo.me";

/**
 * Supplies access tokens to the client.
 *
 * Kept as an interface so the client never owns the token lifecycle: it asks
 * for a token, and on rejection asks for a fresh one exactly once.
 */
export interface AccessTokenProvider {
  /** Return a usable access token, refreshing first if it has expired. */
  getAccessToken(): Promise<string>;
  /** Force a refresh after Zalo rejected the current token, and return the replacement. */
  refreshAccessToken(): Promise<string>;
}

export interface ZaloOaApiClientOptions {
  tokens: AccessTokenProvider;
  /**
   * Prove possession of the app secret on every call.
   *
   * Zalo lets an app require this, and then refuses calls without it with
   * error -242. The proof is `HMAC-SHA256(appSecret, accessToken)`, sent as
   * the `appsecret_proof` header — the scheme Zalo's own SDK implements.
   */
  appSecretProof?: boolean;
  /** Required when `appSecretProof` is set. */
  appSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** How many times to retry a throttled request. Defaults to 2; `0` disables retrying. */
  maxRateLimitRetries?: number;
  /** Delay before the first retry, in milliseconds, doubling each attempt. Defaults to 1000. */
  rateLimitRetryDelayMs?: number;
  /** Injectable delay, for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface ZaloOaRequest {
  method: "GET" | "POST";
  /**
   * Host for this request, when it is not the Open API host. The template
   * management endpoints live on `business.openapi.zalo.me`.
   */
  baseUrl?: string;
  /** Path including the version segment, e.g. `"v3.0/oa/message/cs"`. */
  path: string;
  /**
   * Query parameters.
   *
   * Most Zalo read endpoints take a single `data` parameter holding a JSON
   * object; pass it already serialized.
   */
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * Multipart payload, for the upload endpoints. Replaces `body`.
   *
   * The Content-Type header is left unset so the runtime can add the
   * multipart boundary; setting it by hand produces a body the server cannot
   * parse.
   */
  formData?: FormData;
}

/** The account or app is misconfigured; retrying cannot help, and an operator must act. */
const PERMISSION_CODES: ReadonlySet<number> = new Set([
  ZALO_OA_ERROR.OA_DISABLED,
  ZALO_OA_ERROR.OA_NOT_FOUND,
  ZALO_OA_ERROR.APP_NOT_ACTIVATED,
  ZALO_OA_ERROR.API_NOT_REGISTERED,
  ZALO_OA_ERROR.APP_DISABLED,
  ZALO_OA_ERROR.OA_NOT_VERIFIED,
  ZALO_OA_ERROR.API_NOT_AUTHORIZED,
  ZALO_OA_ERROR.PACKAGE_REQUIRED,
  ZALO_OA_ERROR.UNSUPPORTED_OA_TYPE,
  ZALO_OA_ERROR.INVALID_APPSECRET_PROOF,
  ZALO_OA_ERROR.CLOUD_ACCOUNT_REQUIRED,
  ZALO_OA_ERROR.CLOUD_ACCOUNT_UNPAID,
  // The group's GMF package expired; someone has to renew it.
  ZALO_OA_ERROR.GROUP_DISABLED,
]);

/** This request, or this recipient, will be refused the same way every time. */
const VALIDATION_CODES: ReadonlySet<number> = new Set([
  ZALO_OA_ERROR.ATTACHMENT_EXPIRED,
  ZALO_OA_ERROR.INVALID_PARAM,
  ZALO_OA_ERROR.PARAM_OUT_OF_RANGE,
  ZALO_OA_ERROR.OUT_OF_QUOTA,
  ZALO_OA_ERROR.USER_NOT_FOLLOWER,
  ZALO_OA_ERROR.USER_QUOTA_EXCEEDED,
  ZALO_OA_ERROR.USER_UNREACHABLE,
  ZALO_OA_ERROR.NO_RECENT_INTERACTION,
  ZALO_OA_ERROR.INTERACTION_EXPIRED,
  ZALO_OA_ERROR.UNSUPPORTED_MESSAGE_TYPE,
  ZALO_OA_ERROR.QUIET_HOURS,
  ZALO_OA_ERROR.USER_RESTRICTED,
  ZALO_OA_ERROR.POLICY_VIOLATION,
  // Older templates, OTP templates and a few others go by phone number only.
  ZALO_OA_ERROR.TEMPLATE_NOT_SENDABLE_BY_UID,
  ZALO_OA_ERROR.OA_NOT_IN_GROUP,
]);

/**
 * Translate a Zalo error code into the adapter error taxonomy.
 *
 * Retryability is the distinction that matters to callers:
 * `AdapterRateLimitError` and `NetworkError` are worth retrying, and
 * everything else is not.
 */
export function mapZaloOaError(code: number, message: string): Error {
  const detail = `${message} (error ${code})`;

  if (code === ZALO_OA_ERROR.RATE_LIMITED) {
    return new AdapterRateLimitError(ADAPTER_NAME);
  }
  if (code === ZALO_OA_ERROR.INVALID_ACCESS_TOKEN || code === ZALO_OA_ERROR.ACCESS_TOKEN_EXPIRED) {
    return new AuthenticationError(ADAPTER_NAME, detail);
  }
  if (PERMISSION_CODES.has(code)) {
    return new PermissionError(ADAPTER_NAME, detail);
  }
  if (VALIDATION_CODES.has(code)) {
    return new ValidationError(ADAPTER_NAME, detail);
  }

  // Deliberately retryable, and this includes -200, Zalo's catch-all "send
  // message failed". An unknown code is most often a transient fault or one
  // added after this release; a spurious retry costs one request, while a
  // spurious permanent failure discards a message that would have succeeded.
  return new NetworkError(ADAPTER_NAME, `Unrecognized Zalo OA error: ${detail}`);
}

/** `HMAC-SHA256(appSecret, accessToken)` as lowercase hex: Zalo's `appsecret_proof`. */
export function computeAppSecretProof(appSecret: string, accessToken: string): string {
  return crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/** A non-negative integer, falling back when the value is not a usable one. */
function clampCount(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : fallback;
}

function isTokenRejection(code: number): boolean {
  return code === ZALO_OA_ERROR.INVALID_ACCESS_TOKEN || code === ZALO_OA_ERROR.ACCESS_TOKEN_EXPIRED;
}

/**
 * Thin HTTP client for the Official Account Open API.
 *
 * It centralizes what is easy to get wrong: the custom `access_token` header,
 * the fact that failures arrive as HTTP 200 with a non-zero `error`, and the
 * single retry after a token rejection.
 */
export class ZaloOaApiClient {
  private readonly tokens: AccessTokenProvider;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRateLimitRetries: number;
  private readonly rateLimitRetryDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly appSecret: string | null;

  constructor(options: ZaloOaApiClientOptions) {
    this.tokens = options.tokens;
    if (options.appSecretProof && !options.appSecret) {
      throw new ValidationError(ADAPTER_NAME, "appSecretProof requires the app secret.");
    }
    this.appSecret = options.appSecretProof ? (options.appSecret as string) : null;
    this.baseUrl = (options.baseUrl ?? ZALO_OA_API_HOST).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    // `??` lets NaN through, and `attempt >= NaN` is never true — an unbounded
    // retry loop. A NaN delay is worse: setTimeout(fn, NaN) fires at once,
    // turning the backoff into a hot loop against a rate limiter.
    this.maxRateLimitRetries = clampCount(options.maxRateLimitRetries, 2);
    this.rateLimitRetryDelayMs = clampCount(options.rateLimitRetryDelayMs, 1000);
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  buildUrl(path: string, query?: ZaloOaRequest["query"], baseUrl?: string): string {
    const host = baseUrl ? baseUrl.replace(/\/+$/, "") : this.baseUrl;
    const url = new URL(`${host}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Perform a request, retrying only while Zalo reports throttling.
   *
   * The backoff is short on purpose. It covers a brief burst; a sustained
   * overage will not clear in seconds, and waiting longer inside a request
   * handler would be worse than failing.
   */
  async request<TData>(req: ZaloOaRequest): Promise<TData> {
    let delay = this.rateLimitRetryDelayMs;

    for (let attempt = 0; ; attempt++) {
      // Sequential by definition: a backoff exists to space attempts out.
      // oxlint-disable-next-line no-await-in-loop
      const envelope = await this.attempt<TData>(req);

      if (envelope.error !== ZALO_OA_ERROR.RATE_LIMITED || attempt >= this.maxRateLimitRetries) {
        if (envelope.error !== ZALO_OA_ERROR.OK) {
          throw mapZaloOaError(envelope.error, envelope.message);
        }
        return envelope.data;
      }

      // oxlint-disable-next-line no-await-in-loop
      await this.sleepImpl(delay);
      delay *= 2;
    }
  }

  /** One request, including the single token refresh on rejection. */
  private async attempt<TData>(req: ZaloOaRequest): Promise<ZaloOaApiEnvelope<TData>> {
    const token = await this.tokens.getAccessToken();

    const first = await this.send<TData>(req, token);
    if (!isTokenRejection(first.error)) {
      return first;
    }

    // Rejected despite looking unexpired — revoked, or the clock is off.
    // Refresh once and try again; a second rejection is a real failure.
    const refreshed = await this.tokens.refreshAccessToken();
    return this.send<TData>(req, refreshed);
  }

  private async send<TData>(
    req: ZaloOaRequest,
    accessToken: string,
  ): Promise<ZaloOaApiEnvelope<TData>> {
    const headers: Record<string, string> = { access_token: accessToken };
    if (this.appSecret !== null) {
      // Computed per request rather than cached: the token it proves can be
      // replaced by a refresh between two calls.
      headers.appsecret_proof = computeAppSecretProof(this.appSecret, accessToken);
    }
    let body: BodyInit | undefined;
    if (req.formData) {
      body = req.formData;
    } else if (req.method === "POST") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body ?? {});
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(req.path, req.query, req.baseUrl), {
        method: req.method,
        headers,
        body,
      });
    } catch (error) {
      throw new NetworkError(
        ADAPTER_NAME,
        `${req.path} failed`,
        error instanceof Error ? error : undefined,
      );
    }

    let envelope: ZaloOaApiEnvelope<TData>;
    try {
      envelope = (await response.json()) as ZaloOaApiEnvelope<TData>;
    } catch (error) {
      throw new NetworkError(
        ADAPTER_NAME,
        `Non-JSON response from ${req.path} (HTTP ${response.status})`,
        error instanceof Error ? error : undefined,
      );
    }

    if (typeof envelope?.error !== "number") {
      throw new NetworkError(
        ADAPTER_NAME,
        `Unrecognized response from ${req.path} (HTTP ${response.status})`,
      );
    }

    return envelope;
  }
}
