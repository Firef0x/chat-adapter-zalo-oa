import { ValidationError } from "@chat-adapter/shared";
import { describe, expect, it } from "vitest";

import {
  channelIdFromThreadId,
  decodeChannelId,
  decodeThreadId,
  encodeChannelId,
  encodeThreadId,
} from "../../src/lib/thread-id.js";

describe("thread IDs", () => {
  it("round-trips a user conversation", () => {
    const data = { oaId: "388613280878808645", type: "user" as const, id: "246845883529197922" };
    const threadId = encodeThreadId(data);

    expect(threadId).toBe("zalo-oa:388613280878808645:user:246845883529197922");
    expect(decodeThreadId(threadId)).toEqual(data);
  });

  it("round-trips a group conversation with a hex ID", () => {
    const data = { oaId: "607812198688816074", type: "group" as const, id: "f414c8f76fa586fbdfb4" };
    expect(decodeThreadId(encodeThreadId(data))).toEqual(data);
  });

  it.each([
    ["an empty OA", { oaId: "", type: "user" as const, id: "1" }],
    ["an empty ID", { oaId: "1", type: "user" as const, id: "" }],
    // A colon would shift every later segment and decode to the wrong thread.
    ["a colon in the ID", { oaId: "1", type: "user" as const, id: "a:b" }],
    ["an unknown type", { oaId: "1", type: "channel" as never, id: "2" }],
  ])("refuses to encode %s", (_label, data) => {
    expect(() => encodeThreadId(data)).toThrow(ValidationError);
  });

  it.each([
    "zalo-oa:1:user",
    "zalo-oa:1:user:2:3",
    "tiktok:1:user:2",
    "zalo-oa:1:channel:2",
    "zalo-oa::user:2",
    "zalo-oa:1:user:",
    "zalo-oa:1:user:a b",
  ])("rejects the malformed thread ID %s", (threadId) => {
    expect(() => decodeThreadId(threadId)).toThrow(ValidationError);
  });

  it("round-trips an anonymous conversation, which needs two IDs", () => {
    const data = {
      oaId: "4587655845403518947",
      type: "anonymous" as const,
      id: "1ffedc467f179649cf06",
      conversationId: "fa8f3f8701c2e89cb1d3",
    };
    const threadId = encodeThreadId(data);
    expect(threadId).toBe(
      "zalo-oa:4587655845403518947:anonymous:1ffedc467f179649cf06:fa8f3f8701c2e89cb1d3",
    );
    expect(decodeThreadId(threadId)).toEqual(data);
  });

  it("refuses an anonymous thread without a conversation", () => {
    expect(() => encodeThreadId({ oaId: "1", type: "anonymous", id: "2" })).toThrow(
      ValidationError,
    );
    expect(() => decodeThreadId("zalo-oa:1:anonymous:2")).toThrow(ValidationError);
    expect(() => decodeThreadId("zalo-oa:1:anonymous:2:")).toThrow(ValidationError);
    expect(() => decodeThreadId("zalo-oa:1:anonymous:2:a b")).toThrow(ValidationError);
  });

  it("does not let a user thread carry a fifth segment", () => {
    expect(() => decodeThreadId("zalo-oa:1:user:2:3")).toThrow(ValidationError);
    // A conversation ID on a non-anonymous thread is ignored, not encoded.
    expect(encodeThreadId({ oaId: "1", type: "user", id: "2", conversationId: "3" })).toBe(
      "zalo-oa:1:user:2",
    );
  });

  it("derives the OA's channel from a thread", () => {
    expect(channelIdFromThreadId("zalo-oa:42:user:7")).toBe("zalo-oa:42");
  });

  it("round-trips a channel ID", () => {
    expect(decodeChannelId(encodeChannelId("42"))).toBe("42");
  });

  it.each(["zalo-oa", "zalo-oa:", "zalo-oa:1:2", "tiktok:1", "zalo-oa:a b"])(
    "rejects the malformed channel ID %s",
    (channelId) => {
      expect(() => decodeChannelId(channelId)).toThrow(ValidationError);
    },
  );
});
