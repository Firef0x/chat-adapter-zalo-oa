import { ValidationError } from "@chat-adapter/shared";

import type { ZaloOaThreadId, ZaloOaThreadType } from "../types.js";

export const ADAPTER_NAME = "zalo-oa";

/**
 * What an ID segment may contain.
 *
 * Zalo's IDs are decimal (OA and user IDs) or hex (message and group IDs), so
 * they never need escaping. Rejecting anything else, rather than encoding it,
 * keeps thread IDs readable in logs — and a `:` inside a segment would make
 * the ID decode to the wrong conversation.
 */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const THREAD_TYPES: ReadonlySet<string> = new Set<ZaloOaThreadType>(["user", "group"]);

function assertSegment(value: string, field: string): void {
  if (!value) {
    throw new ValidationError(ADAPTER_NAME, `${field} is required`);
  }
  if (!SEGMENT.test(value)) {
    throw new ValidationError(ADAPTER_NAME, `${field} contains unexpected characters: ${value}`);
  }
}

/** Encode an OA conversation as a Chat SDK thread ID: `zalo-oa:<oaId>:<type>:<id>`. */
export function encodeThreadId(data: ZaloOaThreadId): string {
  assertSegment(data.oaId, "oaId");
  if (!THREAD_TYPES.has(data.type)) {
    throw new ValidationError(ADAPTER_NAME, `Unknown Zalo OA thread type: ${data.type}`);
  }
  assertSegment(data.id, "id");
  return `${ADAPTER_NAME}:${data.oaId}:${data.type}:${data.id}`;
}

/** Decode a thread ID produced by {@link encodeThreadId}. */
export function decodeThreadId(threadId: string): ZaloOaThreadId {
  const parts = threadId.split(":");
  const [prefix, oaId, type, id] = parts;

  if (
    parts.length !== 4 ||
    prefix !== ADAPTER_NAME ||
    !oaId ||
    !id ||
    !type ||
    !THREAD_TYPES.has(type) ||
    !SEGMENT.test(oaId) ||
    !SEGMENT.test(id)
  ) {
    throw new ValidationError(ADAPTER_NAME, `Invalid Zalo OA thread ID: ${threadId}`);
  }

  return { oaId, type: type as ZaloOaThreadType, id };
}

/**
 * Derive the channel ID from a thread ID.
 *
 * The Official Account is the channel: every conversation it holds belongs to
 * it.
 */
export function channelIdFromThreadId(threadId: string): string {
  return encodeChannelId(decodeThreadId(threadId).oaId);
}

/** Encode an Official Account as a channel ID: `zalo-oa:<oaId>`. */
export function encodeChannelId(oaId: string): string {
  assertSegment(oaId, "oaId");
  return `${ADAPTER_NAME}:${oaId}`;
}

/** Decode a channel ID produced by {@link encodeChannelId}. */
export function decodeChannelId(channelId: string): string {
  const parts = channelId.split(":");
  const oaId = parts[1];
  if (parts.length !== 2 || parts[0] !== ADAPTER_NAME || !oaId || !SEGMENT.test(oaId)) {
    throw new ValidationError(ADAPTER_NAME, `Invalid Zalo OA channel ID: ${channelId}`);
  }
  return oaId;
}
