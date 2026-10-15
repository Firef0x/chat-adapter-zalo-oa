import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ValidationError,
} from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import { mapZaloOaError, ZaloOaApiClient } from "../../src/lib/api-client.js";
import { ZALO_OA_ERROR } from "../../src/types.js";

function envelope(error: number, data: unknown = {}, message = error === 0 ? "Success" : "nope") {
  return { status: 200, json: async () => ({ error, message, data }) } as unknown as Response;
}

function tokens(initial = "tok_1", refreshed = "tok_2") {
  return {
    getAccessToken: vi.fn(async () => initial),
    refreshAccessToken: vi.fn(async () => refreshed),
  };
}

function client(fetchImpl: ReturnType<typeof vi.fn>, provider = tokens(), extra = {}) {
  return new ZaloOaApiClient({
    tokens: provider,
    fetchImpl: fetchImpl as never,
    sleepImpl: async () => {},
    ...extra,
  });
}

describe("mapZaloOaError", () => {
  it.each([
    [ZALO_OA_ERROR.RATE_LIMITED, AdapterRateLimitError],
    [ZALO_OA_ERROR.INVALID_ACCESS_TOKEN, AuthenticationError],
    [ZALO_OA_ERROR.ACCESS_TOKEN_EXPIRED, AuthenticationError],
    [ZALO_OA_ERROR.API_NOT_AUTHORIZED, PermissionError],
    [ZALO_OA_ERROR.PACKAGE_REQUIRED, PermissionError],
    [ZALO_OA_ERROR.CLOUD_ACCOUNT_UNPAID, PermissionError],
    [ZALO_OA_ERROR.INVALID_PARAM, ValidationError],
    [ZALO_OA_ERROR.NO_RECENT_INTERACTION, ValidationError],
    [ZALO_OA_ERROR.INTERACTION_EXPIRED, ValidationError],
    [ZALO_OA_ERROR.QUIET_HOURS, ValidationError],
    [ZALO_OA_ERROR.TEMPLATE_NOT_SENDABLE_BY_UID, ValidationError],
    [ZALO_OA_ERROR.OA_NOT_IN_GROUP, ValidationError],
    [ZALO_OA_ERROR.GROUP_DISABLED, PermissionError],
    // The generic send failure and anything unknown stay retryable.
    [ZALO_OA_ERROR.SEND_FAILED, NetworkError],
    [-9999, NetworkError],
  ])("maps %i to %o", (code, type) => {
    expect(mapZaloOaError(code, "nope")).toBeInstanceOf(type);
  });

  it("keeps Zalo's message and code in the error", () => {
    expect(mapZaloOaError(-230, "User has not interacted").message).toContain(
      "User has not interacted (error -230)",
    );
  });
});

describe("ZaloOaApiClient", () => {
  it("sends a JSON POST with the access_token header", async () => {
    const fetchImpl = vi.fn(async () => envelope(0, { message_id: "m1" }));
    const data = await client(fetchImpl).request({
      method: "POST",
      path: "v3.0/oa/message/cs",
      body: { a: 1 },
    });

    expect(data).toEqual({ message_id: "m1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openapi.zalo.me/v3.0/oa/message/cs");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ access_token: "tok_1", "Content-Type": "application/json" });
    expect(init.body).toBe('{"a":1}');
  });

  it("sends a GET without a body, encoding the data parameter", async () => {
    const fetchImpl = vi.fn(async () => envelope(0, []));
    await client(fetchImpl).request({
      method: "GET",
      path: "/v2.0/oa/conversation",
      query: { data: JSON.stringify({ user_id: "7", offset: 0 }), skip: undefined },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v2.0/oa/conversation");
    expect(JSON.parse(parsed.searchParams.get("data") as string)).toEqual({
      user_id: "7",
      offset: 0,
    });
    expect(parsed.searchParams.has("skip")).toBe(false);
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ access_token: "tok_1" });
  });

  it("sends a request to its own host when it names one", async () => {
    const fetchImpl = vi.fn(async () => envelope(0, []));
    await client(fetchImpl).request({
      method: "GET",
      baseUrl: "https://business.openapi.zalo.me/",
      path: "template/all",
      query: { offset: 0 },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://business.openapi.zalo.me/template/all?offset=0",
    );
  });

  it("strips a trailing slash from a custom base URL", () => {
    const api = client(vi.fn(), tokens(), { baseUrl: "https://proxy.example/" });
    expect(api.buildUrl("v2.0/oa/getoa")).toBe("https://proxy.example/v2.0/oa/getoa");
  });

  it("throws the mapped error for a failure reported as HTTP 200", async () => {
    const fetchImpl = vi.fn(async () => envelope(ZALO_OA_ERROR.INVALID_PARAM));
    await expect(client(fetchImpl).request({ method: "GET", path: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refreshes once after a token rejection and retries with the new token", async () => {
    const provider = tokens();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope(ZALO_OA_ERROR.ACCESS_TOKEN_EXPIRED))
      .mockResolvedValueOnce(envelope(0, { ok: true }));

    await expect(
      client(fetchImpl, provider).request({ method: "GET", path: "x" }),
    ).resolves.toEqual({ ok: true });
    expect(provider.refreshAccessToken).toHaveBeenCalledTimes(1);
    const second = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((second[1].headers as Record<string, string>).access_token).toBe("tok_2");
  });

  it("gives up after a second token rejection", async () => {
    const provider = tokens();
    const fetchImpl = vi.fn(async () => envelope(ZALO_OA_ERROR.INVALID_ACCESS_TOKEN));

    await expect(
      client(fetchImpl, provider).request({ method: "GET", path: "x" }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(provider.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries throttling with doubling backoff, then surfaces it", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => envelope(ZALO_OA_ERROR.RATE_LIMITED));
    const api = client(fetchImpl, tokens(), {
      maxRateLimitRetries: 2,
      rateLimitRetryDelayMs: 100,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    await expect(api.request({ method: "GET", path: "x" })).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("recovers when throttling clears", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope(ZALO_OA_ERROR.RATE_LIMITED))
      .mockResolvedValueOnce(envelope(0, { ok: 1 }));

    await expect(client(fetchImpl).request({ method: "GET", path: "x" })).resolves.toEqual({
      ok: 1,
    });
  });

  it.each([Number.NaN, -1])("falls back to sane retry settings for %s", async (value) => {
    // NaN would never satisfy `attempt >= max`, looping forever.
    const fetchImpl = vi.fn(async () => envelope(ZALO_OA_ERROR.RATE_LIMITED));
    const api = client(fetchImpl, tokens(), { maxRateLimitRetries: value });

    await expect(api.request({ method: "GET", path: "x" })).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(Number.isNaN(value) ? 3 : 1);
  });

  it("wraps a transport failure as a retryable NetworkError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("socket hang up");
    });
    await expect(client(fetchImpl).request({ method: "GET", path: "x" })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("reports a non-JSON body as a NetworkError with the HTTP status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          status: 502,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        }) as unknown as Response,
    );
    await expect(client(fetchImpl).request({ method: "GET", path: "x" })).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it("rejects a JSON body with no numeric error field", async () => {
    const fetchImpl = vi.fn(
      async () => ({ status: 200, json: async () => ({ data: {} }) }) as unknown as Response,
    );
    await expect(client(fetchImpl).request({ method: "GET", path: "x" })).rejects.toThrow(
      /Unrecognized response/,
    );
  });
});
