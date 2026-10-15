import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-zevent-signature";

/**
 * Permitted signature age, in seconds.
 *
 * Zalo redelivers an event it could not hand over at 30 s, 5 min, 15 min,
 * 30 min and 1 h — about 1 h 51 min in all — and each retry carries the
 * *original* body, timestamp included. A window shorter than that schedule
 * rejects precisely the retries that exist to recover an outage. Two hours
 * covers the schedule with margin while still refusing a capture replayed
 * days later.
 */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 7200;

export type VerificationResult =
  | { valid: true }
  | {
      valid: false;
      reason: string;
      /**
       * The signature is genuine but older than the tolerance.
       *
       * Worth distinguishing: answering such a delivery with an error status
       * counts against the webhook's health at Zalo, which disables webhooks
       * that keep failing — while the delivery itself is authentic.
       */
      stale: boolean;
    };

export interface VerifyOptions {
  /** Raw `X-ZEvent-Signature` header value: `mac=<hex>`. */
  header: string | null;
  /**
   * The **raw** request body.
   *
   * Must be the bytes as received. Parsing the JSON and re-serializing it does
   * not round-trip, so the recomputed digest would never match.
   */
  rawBody: string;
  /** The configured app ID — not the one in the body, which an attacker controls. */
  appId: string;
  /** The body's own `timestamp` field, exactly as it appears in the JSON. */
  timestamp: string;
  oaSecretKey: string;
  /** Epoch milliseconds. */
  now?: number;
  /** Defaults to {@link DEFAULT_SIGNATURE_TOLERANCE_SECONDS}, also when not a non-negative number. */
  toleranceSeconds?: number;
}

/** `sha256(appId + rawBody + timestamp + oaSecretKey)`, hex-encoded. */
export function computeSignature(
  appId: string,
  rawBody: string,
  timestamp: string,
  oaSecretKey: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${appId}${rawBody}${timestamp}${oaSecretKey}`)
    .digest("hex");
}

/** Build a header value. Used by tests and for local verification. */
export function signWebhookBody(
  rawBody: string,
  appId: string,
  timestamp: string,
  oaSecretKey: string,
): string {
  return `mac=${computeSignature(appId, rawBody, timestamp, oaSecretKey)}`;
}

/**
 * Extract the digest from a header value.
 *
 * The documented form is `mac=<hex>`. A bare digest is accepted too, since
 * the prefix carries no information and a proxy that strips it should not
 * turn every delivery into a 401.
 */
function parseSignatureHeader(header: string): string | null {
  const trimmed = header.trim();
  const separator = trimmed.indexOf("=");
  const digest = separator === -1 ? trimmed : trimmed.slice(separator + 1).trim();
  if (separator !== -1 && trimmed.slice(0, separator).trim().toLowerCase() !== "mac") {
    return null;
  }
  return /^[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

/**
 * Verify a webhook signature, failing closed.
 *
 * Every failure path returns `valid: false` with a reason rather than
 * throwing, so the caller can log the cause.
 */
export function verifyWebhookSignature(options: VerifyOptions): VerificationResult {
  const { header, rawBody, appId, timestamp, oaSecretKey, now = Date.now() } = options;
  // A destructuring default covers only `undefined`. `NaN` would make the
  // age comparison below never true and so accept a capture replayed years
  // later; a negative value would reject every delivery.
  const toleranceSeconds =
    Number.isFinite(options.toleranceSeconds) && (options.toleranceSeconds as number) >= 0
      ? (options.toleranceSeconds as number)
      : DEFAULT_SIGNATURE_TOLERANCE_SECONDS;

  if (!header) {
    return { valid: false, reason: "missing signature header", stale: false };
  }

  const provided = parseSignatureHeader(header);
  if (!provided) {
    return { valid: false, reason: "malformed signature header", stale: false };
  }

  const expected = computeSignature(appId, rawBody, timestamp, oaSecretKey);
  // Both are 64 hex characters by construction, so the lengths always match.
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return { valid: false, reason: "signature mismatch", stale: false };
  }

  // Checked only after the digest matches: a stale stamp on a genuine
  // signature is a late retry or a replay, not a forgery.
  const sentMs = Number(timestamp);
  if (!timestamp || !Number.isFinite(sentMs)) {
    return { valid: false, reason: "signature timestamp is not a number", stale: false };
  }
  const ageSeconds = Math.abs(now - sentMs) / 1000;
  if (ageSeconds > toleranceSeconds) {
    return {
      valid: false,
      reason: `signature timestamp is ${Math.round(ageSeconds)}s away from local time`,
      stale: true,
    };
  }

  return { valid: true };
}
