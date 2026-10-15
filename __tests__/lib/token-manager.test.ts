import { AuthenticationError, NetworkError } from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import {
  REFRESH_SKEW_MS,
  REFRESH_TOKEN_LIFETIME_MS,
  ZaloOaTokenManager,
} from "../../src/lib/token-manager.js";

const NOW = 1_700_000_000_000;

function tokenResponse(body: unknown, status = 200) {
  return { status, json: async () => body } as unknown as Response;
}

const GRANT = { access_token: "acc_2", refresh_token: "ref_2", expires_in: "90000" };

function manager(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<ConstructorParameters<typeof ZaloOaTokenManager>[0]> = {},
) {
  return new ZaloOaTokenManager({
    appId: "app_1",
    appSecret: "secret_1",
    accessToken: "acc_1",
    refreshToken: "ref_1",
    accessTokenExpiresAt: NOW + 60 * 60 * 1000,
    fetchImpl: fetchImpl as never,
    now: () => NOW,
    ...overrides,
  });
}

describe("ZaloOaTokenManager", () => {
  it("returns the current token while it is fresh", async () => {
    const fetchImpl = vi.fn();
    await expect(manager(fetchImpl).getAccessToken()).resolves.toBe("acc_1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes inside the skew window", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    const tokens = manager(fetchImpl, { accessTokenExpiresAt: NOW + REFRESH_SKEW_MS });
    await expect(tokens.getAccessToken()).resolves.toBe("acc_2");
  });

  it("refreshes when the expiry is unknown", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    await expect(
      manager(fetchImpl, { accessTokenExpiresAt: undefined }).getAccessToken(),
    ).resolves.toBe("acc_2");
  });

  it("posts a form-encoded refresh with the secret in the secret_key header", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    await manager(fetchImpl).refreshAccessToken();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth.zaloapp.com/v4/oa/access_token");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      secret_key: "secret_1",
    });
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      refresh_token: "ref_1",
      app_id: "app_1",
      grant_type: "refresh_token",
    });
  });

  it("adopts the rotated grant and reports it to the host", async () => {
    const onTokenRefresh = vi.fn();
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    const tokens = manager(fetchImpl, { onTokenRefresh });

    await tokens.refreshAccessToken();

    const expected = {
      accessToken: "acc_2",
      refreshToken: "ref_2",
      accessTokenExpiresAt: NOW + 90_000 * 1000,
      refreshTokenExpiresAt: NOW + REFRESH_TOKEN_LIFETIME_MS,
    };
    expect(tokens.getTokens()).toEqual(expected);
    expect(onTokenRefresh).toHaveBeenCalledWith(expected);
  });

  it("uses the rotated refresh token on the next refresh", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(GRANT))
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "acc_3", refresh_token: "ref_3", expires_in: 90000 }),
      );
    const tokens = manager(fetchImpl);

    await tokens.refreshAccessToken();
    await tokens.refreshAccessToken();

    const second = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URLSearchParams(second[1].body as string).get("refresh_token")).toBe("ref_2");
  });

  it("shares one refresh between concurrent callers", async () => {
    // The refresh token is single-use: a second concurrent refresh would
    // spend a token the first already invalidated.
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    const tokens = manager(fetchImpl);

    const results = await Promise.all([
      tokens.refreshAccessToken(),
      tokens.refreshAccessToken(),
      tokens.refreshAccessToken(),
    ]);

    expect(results).toEqual(["acc_2", "acc_2", "acc_2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to refresh once the refresh token has expired", async () => {
    const fetchImpl = vi.fn();
    await expect(
      manager(fetchImpl, { refreshTokenExpiresAt: NOW }).refreshAccessToken(),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats Zalo's refusal as terminal, quoting its reason", async () => {
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ error: -14014, error_name: "Invalid refresh token" }),
    );
    const failure = manager(fetchImpl).refreshAccessToken();
    await expect(failure).rejects.toBeInstanceOf(AuthenticationError);
    await expect(failure).rejects.toThrow(/-14014: Invalid refresh token/);
  });

  it.each([
    ["no expires_in", { access_token: "a", refresh_token: "r" }],
    ["a zero expires_in", { ...GRANT, expires_in: "0" }],
    ["a non-numeric expires_in", { ...GRANT, expires_in: "soon" }],
    ["no refresh token", { access_token: "a", expires_in: "90000" }],
  ])("rejects a grant with %s and keeps the old tokens", async (_label, body) => {
    const fetchImpl = vi.fn(async () => tokenResponse(body));
    const tokens = manager(fetchImpl);

    await expect(tokens.refreshAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    expect(tokens.getTokens().refreshToken).toBe("ref_1");
  });

  it("treats a gateway error as retryable", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({}, 503));
    await expect(manager(fetchImpl).refreshAccessToken()).rejects.toBeInstanceOf(NetworkError);
  });

  it("treats a transport failure and a non-JSON body as retryable", async () => {
    const thrown = vi.fn(async () => {
      throw new TypeError("reset");
    });
    await expect(manager(thrown).refreshAccessToken()).rejects.toBeInstanceOf(NetworkError);

    const html = vi.fn(
      async () =>
        ({
          status: 502,
          json: async () => {
            throw new SyntaxError("<html>");
          },
        }) as unknown as Response,
    );
    await expect(manager(html).refreshAccessToken()).rejects.toThrow(/HTTP 502/);
  });

  it("keeps serving when persisting the new tokens fails, and logs it at the current logger", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    let current = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    const tokens = manager(fetchImpl, {
      onTokenRefresh: async () => {
        throw new Error("db down");
      },
      logger: () => current as never,
    });
    // Swapped after construction, as the adapter does in initialize().
    current = logger;

    await expect(tokens.refreshAccessToken()).resolves.toBe("acc_2");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist refreshed Zalo OA tokens"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("honours a custom OAuth host", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse(GRANT));
    await manager(fetchImpl, { oauthBaseUrl: "https://oauth.proxy/" }).refreshAccessToken();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://oauth.proxy/v4/oa/access_token");
  });
});
