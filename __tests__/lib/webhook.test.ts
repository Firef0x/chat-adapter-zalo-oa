import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeSignature,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  signWebhookBody,
  verifyWebhookSignature,
} from "../../src/lib/webhook.js";

const APP_ID = "360846524940903967";
const SECRET = "oa_secret_key";
const NOW = 1_700_000_000_000;
const TIMESTAMP = String(NOW);
const BODY = JSON.stringify({ app_id: APP_ID, event_name: "user_send_text", timestamp: TIMESTAMP });

function verify(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
  return verifyWebhookSignature({
    header: signWebhookBody(BODY, APP_ID, TIMESTAMP, SECRET),
    rawBody: BODY,
    appId: APP_ID,
    timestamp: TIMESTAMP,
    oaSecretKey: SECRET,
    now: NOW,
    ...overrides,
  });
}

describe("computeSignature", () => {
  it("hashes appId, body, timestamp and secret in that order, unkeyed", () => {
    // Zalo's documented formula is a plain SHA-256 over the concatenation,
    // not an HMAC. Pinned against an independent computation so a reordering
    // or a switch to HMAC fails here rather than against live traffic.
    const expected = crypto
      .createHash("sha256")
      .update(`${APP_ID}${BODY}${TIMESTAMP}${SECRET}`)
      .digest("hex");

    expect(computeSignature(APP_ID, BODY, TIMESTAMP, SECRET)).toBe(expected);
  });

  it("formats the header as mac=<hex>", () => {
    expect(signWebhookBody(BODY, APP_ID, TIMESTAMP, SECRET)).toMatch(/^mac=[0-9a-f]{64}$/);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature", () => {
    expect(verify()).toEqual({ valid: true });
  });

  it("accepts a bare digest and ignores surrounding whitespace and case", () => {
    const digest = computeSignature(APP_ID, BODY, TIMESTAMP, SECRET);
    expect(verify({ header: digest })).toEqual({ valid: true });
    expect(verify({ header: `  MAC = ${digest.toUpperCase()} ` })).toEqual({ valid: true });
  });

  it("rejects a missing header", () => {
    expect(verify({ header: null })).toEqual({
      valid: false,
      reason: "missing signature header",
      stale: false,
    });
  });

  it.each(["mac=", "mac=xyz", "sig=" + "a".repeat(64), "a".repeat(63)])(
    "rejects the malformed header %s",
    (header) => {
      expect(verify({ header })).toMatchObject({
        valid: false,
        reason: "malformed signature header",
        stale: false,
      });
    },
  );

  it.each([
    ["a different secret", { oaSecretKey: "other" }],
    ["a different app", { appId: "1" }],
    ["a tampered body", { rawBody: `${BODY} ` }],
    ["a different timestamp", { timestamp: String(NOW + 1) }],
  ])("rejects %s", (_label, overrides) => {
    expect(verify(overrides)).toEqual({ valid: false, reason: "signature mismatch", stale: false });
  });

  it("accepts a signature at the edge of the tolerance and flags one past it as stale", () => {
    const edge = NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS * 1000;
    expect(verify({ now: edge })).toEqual({ valid: true });

    const result = verify({ now: edge + 1000 });
    expect(result).toMatchObject({ valid: false, stale: true });
  });

  it("covers Zalo's whole retry schedule by default", () => {
    // 30 s + 5 min + 15 min + 30 min + 1 h, each retry carrying the original
    // timestamp. Dropping the last one would lose exactly what retries exist
    // to recover.
    const lastRetry = NOW + (30 + 5 * 60 + 15 * 60 + 30 * 60 + 60 * 60) * 1000;
    expect(verify({ now: lastRetry })).toEqual({ valid: true });
  });

  it("honours a custom tolerance", () => {
    expect(verify({ now: NOW + 61_000, toleranceSeconds: 60 })).toMatchObject({ stale: true });
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "falls back to the default tolerance when given %s",
    (toleranceSeconds) => {
      // NaN would otherwise accept a capture replayed years later, and a
      // negative value would reject every delivery.
      expect(verify({ now: NOW + 1000, toleranceSeconds })).toEqual({ valid: true });
      expect(
        verify({ now: NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS * 1000 + 1000, toleranceSeconds }),
      ).toMatchObject({ valid: false, stale: true });
    },
  );

  it("rejects a signed but non-numeric timestamp without calling it stale", () => {
    const header = signWebhookBody(BODY, APP_ID, "soon", SECRET);
    expect(verify({ header, timestamp: "soon" })).toEqual({
      valid: false,
      reason: "signature timestamp is not a number",
      stale: false,
    });
  });
});
