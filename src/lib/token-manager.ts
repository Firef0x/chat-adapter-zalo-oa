import { AuthenticationError, NetworkError } from "@chat-adapter/shared";
import type { Logger } from "chat";
import { ConsoleLogger } from "chat";

import type { ZaloOaTokenResponse, ZaloOaTokens } from "../types.js";
import type { AccessTokenProvider } from "./api-client.js";
import { ADAPTER_NAME } from "./thread-id.js";

export const ZALO_OAUTH_HOST = "https://oauth.zaloapp.com";

/**
 * How long before expiry a token is considered stale.
 *
 * This shifts each refresh slightly earlier and avoids racing the expiry on a
 * request that would otherwise fail in flight.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Zalo documents refresh tokens as valid for three months from issue. */
export const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface TokenManagerOptions {
  appId: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  onTokenRefresh?: (tokens: ZaloOaTokens) => void | Promise<void>;
  oauthBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests. */
  now?: () => number;
  /**
   * Resolved on each use rather than captured, because the adapter swaps its
   * logger for the host's during `initialize()`. A captured reference would
   * send a failure to persist rotated credentials — the most consequential
   * thing this class can log — to stdout instead of the host's pipeline.
   */
  logger?: Logger | (() => Logger);
}

/**
 * Owns the access-token lifecycle for one Official Account.
 *
 * Access tokens live 25 hours. Refresh tokens live three months and are
 * single-use: every refresh invalidates the old one and the old access token
 * with it — so this class is also responsible for handing the rotated
 * credentials back to the host.
 */
export class ZaloOaTokenManager implements AccessTokenProvider {
  private accessToken: string;
  private refreshToken: string;
  private accessTokenExpiresAt: number;
  private refreshTokenExpiresAt: number;

  /** Shared by every caller that arrives while a refresh is in flight. */
  private inflight: Promise<string> | null = null;

  private readonly options: TokenManagerOptions;
  private readonly now: () => number;

  constructor(options: TokenManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    // Unknown expiry is treated as expired: one refresh up front beats
    // discovering the expiry through a failed API call.
    this.accessTokenExpiresAt = options.accessTokenExpiresAt ?? 0;
    this.refreshTokenExpiresAt = options.refreshTokenExpiresAt ?? Number.POSITIVE_INFINITY;
  }

  /** Current credentials, for a host that wants to persist them. */
  getTokens(): ZaloOaTokens {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt,
    };
  }

  private get logger(): Logger {
    const configured = this.options.logger;
    if (typeof configured === "function") {
      return configured();
    }
    return configured ?? new ConsoleLogger();
  }

  async getAccessToken(): Promise<string> {
    if (this.now() < this.accessTokenExpiresAt - REFRESH_SKEW_MS) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  /**
   * Refresh unconditionally.
   *
   * Concurrent callers share one in-flight request. Without this, a burst
   * arriving at expiry would each spend the single-use refresh token, and
   * every refresh but the first would be refused.
   */
  refreshAccessToken(): Promise<string> {
    this.inflight ??= this.performRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async performRefresh(): Promise<string> {
    if (this.now() >= this.refreshTokenExpiresAt) {
      throw new AuthenticationError(
        ADAPTER_NAME,
        "Zalo OA refresh token has expired. The OA must authorize the app again.",
      );
    }

    const url = `${(this.options.oauthBaseUrl ?? ZALO_OAUTH_HOST).replace(/\/+$/, "")}/v4/oa/access_token`;
    const fetchImpl = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          secret_key: this.options.appSecret,
        },
        body: new URLSearchParams({
          refresh_token: this.refreshToken,
          app_id: this.options.appId,
          grant_type: "refresh_token",
        }).toString(),
      });
    } catch (error) {
      throw new NetworkError(
        ADAPTER_NAME,
        "The Zalo OA token refresh failed",
        error instanceof Error ? error : undefined,
      );
    }

    let data: ZaloOaTokenResponse;
    try {
      data = (await response.json()) as ZaloOaTokenResponse;
    } catch (error) {
      throw new NetworkError(
        ADAPTER_NAME,
        `Non-JSON response from the Zalo OA token refresh (HTTP ${response.status})`,
        error instanceof Error ? error : undefined,
      );
    }

    this.applyTokenResponse(data, response.status);
    await this.notifyHost();
    return this.accessToken;
  }

  /**
   * Adopt a refreshed grant, but only if it is complete.
   *
   * A partial payload applied blindly is worse than a failed refresh: a
   * missing `expires_in` yields `NaN`, which fails the freshness check on
   * every call and turns traffic into a refresh-per-request storm — and the
   * host would be handed, and would persist, an `undefined` refresh token over
   * its good one.
   */
  private applyTokenResponse(data: ZaloOaTokenResponse, status: number): void {
    const expiresInSeconds = Number(data?.expires_in);

    if (
      !data?.access_token ||
      !data.refresh_token ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0
    ) {
      // A gateway fault can still be retried with the same refresh token;
      // anything Zalo itself refused means that token will not work again.
      if (status >= 500) {
        throw new NetworkError(
          ADAPTER_NAME,
          `The Zalo OA token refresh failed with HTTP ${status}`,
        );
      }
      const reason = data?.error_description ?? data?.error_name ?? "incomplete token response";
      throw new AuthenticationError(
        ADAPTER_NAME,
        `Zalo refused to refresh the OA access token (${data?.error ?? "no code"}: ${reason}). The OA must authorize the app again.`,
      );
    }

    const now = this.now();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.accessTokenExpiresAt = now + expiresInSeconds * 1000;
    this.refreshTokenExpiresAt = now + REFRESH_TOKEN_LIFETIME_MS;
  }

  private async notifyHost(): Promise<void> {
    if (!this.options.onTokenRefresh) {
      return;
    }

    try {
      await this.options.onTokenRefresh(this.getTokens());
    } catch (error) {
      // The rotation already happened at Zalo, so failing the caller would
      // not undo it — and the new token works in memory. Log loudly: until
      // persistence succeeds, a restart loses the connection for good.
      this.logger.error(
        "Failed to persist refreshed Zalo OA tokens. The connection will break on restart unless they are saved.",
        { error },
      );
    }
  }
}
