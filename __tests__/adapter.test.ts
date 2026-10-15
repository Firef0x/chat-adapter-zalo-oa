import crypto from "node:crypto";

import { NetworkError, ValidationError } from "@chat-adapter/shared";
import type { Message } from "chat";
import { emoji, NotImplementedError } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ZaloOaAdapter } from "../src/adapter.js";
import { getStickerId } from "../src/lib/media.js";
import { signWebhookBody } from "../src/lib/webhook.js";
import type { ZaloOaHistoryMessage, ZaloOaRawMessage, ZaloOaWebhookEvent } from "../src/types.js";
import { ZALO_OA_ERROR } from "../src/types.js";

const APP_ID = "360846524940903967";
const OA_SECRET = "oa_secret_key";
const OA_ID = "388613280878808645";
const USER_ID = "246845883529197922";
const THREAD_ID = `zalo-oa:${OA_ID}:user:${USER_ID}`;
const T0 = 1_700_000_000_000;

function ok(data: unknown) {
  return {
    status: 200,
    json: async () => ({ error: 0, message: "Success", data }),
  } as unknown as Response;
}

function fail(error: number) {
  return {
    status: 200,
    json: async () => ({ error, message: "nope", data: {} }),
  } as unknown as Response;
}

function userEvent(overrides: Partial<ZaloOaWebhookEvent> = {}): ZaloOaWebhookEvent {
  return {
    app_id: APP_ID,
    event_name: "user_send_text",
    sender: { id: USER_ID },
    recipient: { id: OA_ID },
    user_id_by_app: "552177279717587730",
    message: { msg_id: "msg_1", text: "hello there" },
    timestamp: String(Date.now()),
    ...overrides,
  };
}

function webhookRequest(
  event: unknown,
  options: { secret?: string; header?: string | null; rawBody?: string } = {},
) {
  const body = options.rawBody ?? JSON.stringify(event);
  const timestamp = String((event as { timestamp?: unknown })?.timestamp ?? "");
  const header =
    options.header === undefined
      ? signWebhookBody(body, APP_ID, timestamp, options.secret ?? OA_SECRET)
      : options.header;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) {
    headers["X-ZEvent-Signature"] = header;
  }
  return new Request("https://example.com/webhooks/zalo", { method: "POST", headers, body });
}

function build(fetchImpl: ReturnType<typeof vi.fn> = vi.fn(async () => ok({}))) {
  const adapter = new ZaloOaAdapter({
    appId: APP_ID,
    appSecret: "app_secret",
    oaSecretKey: OA_SECRET,
    oaId: OA_ID,
    accessToken: "acc_1",
    refreshToken: "ref_1",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    fetchImpl: fetchImpl as never,
    sleepImpl: async () => {},
  });
  return { adapter, fetchImpl };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** A GIF89a header declaring 320 x 240. */
const GIF = Buffer.concat([
  Buffer.from("GIF89a", "latin1"),
  Buffer.from([0x40, 0x01, 0xf0, 0x00]),
  Buffer.from([0, 0, 0]),
]);
const PDF = Buffer.from("%PDF-1.7 hello", "latin1");

/**
 * A fetch stand-in that answers uploads with an ID and sends with a message.
 * Records each request's URL and body for assertions.
 */
function mediaFetch(upload: Record<string, unknown> = { attachment_id: "att_1" }) {
  return vi.fn(async (url: string) => {
    if (url.includes("/upload/")) {
      return ok(upload);
    }
    return ok({ message_id: "sent_1", user_id: USER_ID, sent_time: String(T0) });
  });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>) {
  const call = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith("/v3.0/oa/message/cs"));
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

/** Minimal ChatInstance stand-in that records dispatched messages. */
function attachChat() {
  const processed: Array<{
    threadId: string;
    message: Message<ZaloOaRawMessage>;
    options: unknown;
  }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const chat = {
    getLogger: () => logger,
    processMessage: vi.fn(
      (
        _adapter: unknown,
        threadId: string,
        message: Message<ZaloOaRawMessage>,
        options: unknown,
      ) => {
        processed.push({ threadId, message, options });
        return Promise.resolve();
      },
    ),
    processReaction: vi.fn(),
  };
  return { chat, processed, logger };
}

async function initialized(fetchImpl?: ReturnType<typeof vi.fn>) {
  const built = build(fetchImpl);
  const attached = attachChat();
  await built.adapter.initialize(attached.chat as never);
  return { ...built, ...attached };
}

function lastCall(fetchImpl: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

describe("ZaloOaAdapter", () => {
  describe("identity", () => {
    it("uses the OA as the bot and the channel", () => {
      const { adapter } = build();
      expect(adapter.name).toBe("zalo-oa");
      expect(adapter.userName).toBe("zalo-oa-bot");
      expect(adapter.botUserId).toBe(OA_ID);
      expect(adapter.channelIdFromThreadId(THREAD_ID)).toBe(`zalo-oa:${OA_ID}`);
    });

    it("treats user threads as DMs and group threads as not", () => {
      const { adapter } = build();
      expect(adapter.isDM(THREAD_ID)).toBe(true);
      expect(adapter.isDM(`zalo-oa:${OA_ID}:group:abc123`)).toBe(false);
    });

    it("opens a DM as the user's thread", async () => {
      const { adapter } = build();
      await expect(adapter.openDM(USER_ID)).resolves.toBe(THREAD_ID);
    });

    it("refuses to describe another OA's thread", async () => {
      const { adapter } = build();
      await expect(adapter.fetchThread(`zalo-oa:111:user:${USER_ID}`)).rejects.toThrow(
        /different Official Account/,
      );
    });

    it("describes a thread without a request", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.fetchThread(THREAD_ID)).resolves.toEqual({
        id: THREAD_ID,
        channelId: `zalo-oa:${OA_ID}`,
        isDM: true,
        metadata: {},
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("webhook verification", () => {
    it("accepts a signed delivery and answers 200", async () => {
      const { adapter, processed } = await initialized();
      const response = await adapter.handleWebhook(webhookRequest(userEvent()));
      expect(response.status).toBe(200);
      expect(processed).toHaveLength(1);
    });

    it("rejects a forged signature with 401 and dispatches nothing", async () => {
      const { adapter, processed, logger } = await initialized();
      const response = await adapter.handleWebhook(
        webhookRequest(userEvent(), { secret: "wrong" }),
      );
      expect(response.status).toBe(401);
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith("Rejected Zalo OA webhook", {
        reason: "signature mismatch",
      });
    });

    it("rejects a missing signature with 401", async () => {
      const { adapter } = await initialized();
      const response = await adapter.handleWebhook(webhookRequest(userEvent(), { header: null }));
      expect(response.status).toBe(401);
    });

    it("verifies with the configured app ID, not the one in the body", async () => {
      // The body's app_id is attacker-controlled. Signing with it would let a
      // forger who knows any secret pick the app the digest is checked for.
      const { adapter } = await initialized();
      const event = userEvent({ app_id: "999" });
      const body = JSON.stringify(event);
      const forged = signWebhookBody(body, "999", event.timestamp, OA_SECRET);
      const response = await adapter.handleWebhook(webhookRequest(event, { header: forged }));
      expect(response.status).toBe(401);
    });

    it("answers a stale but genuine delivery with 200 and drops it", async () => {
      const { adapter, processed, logger } = await initialized();
      const event = userEvent({ timestamp: String(Date.now() - 3 * 60 * 60 * 1000) });
      const response = await adapter.handleWebhook(webhookRequest(event));

      expect(response.status).toBe(200);
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "Dropped a stale Zalo OA webhook",
        expect.objectContaining({ event: "user_send_text" }),
      );
    });

    it.each([
      ["a GET", new Request("https://example.com/webhooks/zalo", { method: "GET" })],
      ["a HEAD", new Request("https://example.com/webhooks/zalo", { method: "HEAD" })],
      ["an empty POST", webhookRequest(null, { rawBody: "", header: null })],
      ["a whitespace POST", webhookRequest(null, { rawBody: " \n", header: null })],
    ])(
      "answers %s, as the console's URL check sends, with 200 and dispatches nothing",
      async (_label, request) => {
        const { adapter, processed, logger } = await initialized();
        const response = await adapter.handleWebhook(request);
        expect(response.status).toBe(200);
        expect(processed).toHaveLength(0);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
      },
    );

    it("answers a non-JSON body with 400", async () => {
      const { adapter } = await initialized();
      const response = await adapter.handleWebhook(webhookRequest({}, { rawBody: "not json" }));
      expect(response.status).toBe(400);
    });

    it("rejects a JSON body with no timestamp", async () => {
      const { adapter } = await initialized();
      const event = { ...userEvent(), timestamp: undefined };
      const response = await adapter.handleWebhook(webhookRequest(event));
      expect(response.status).toBe(401);
    });

    it.each(["null", "42", '"text"', "[1]"])(
      "answers the JSON non-object body %s with 400 without reading it",
      async (rawBody) => {
        const { adapter, logger } = await initialized();
        const response = await adapter.handleWebhook(
          webhookRequest(null, { rawBody, header: "mac=" + "0".repeat(64) }),
        );
        expect(response.status).toBe(400);
        expect(logger.error).not.toHaveBeenCalled();
      },
    );
  });

  describe("inbound messages", () => {
    it("dispatches a text message to the user's thread", async () => {
      const { adapter, processed } = await initialized();
      const options = { waitUntil: vi.fn() };
      await adapter.handleWebhook(webhookRequest(userEvent()), options);

      expect(processed).toHaveLength(1);
      const [{ threadId, message, options: passed }] = processed as [(typeof processed)[number]];
      expect(threadId).toBe(THREAD_ID);
      expect(passed).toBe(options);
      expect(message.id).toBe("msg_1");
      expect(message.text).toBe("hello there");
      expect(message.threadId).toBe(THREAD_ID);
      expect(message.author).toEqual({
        userId: USER_ID,
        userName: USER_ID,
        fullName: "",
        isBot: false,
        isMe: false,
      });
    });

    it("answers before the host's handler finishes", async () => {
      // Zalo wants a response within two seconds; a handler calling a model
      // takes longer. The SDK owns the task, via waitUntil when given.
      const { adapter, chat } = await initialized();
      chat.processMessage.mockImplementation(() => new Promise(() => {}));
      const response = await adapter.handleWebhook(webhookRequest(userEvent()));
      expect(response.status).toBe(200);
    });

    it("dates the message from the webhook timestamp", async () => {
      const { adapter, processed } = await initialized();
      const now = Date.now();
      await adapter.handleWebhook(webhookRequest(userEvent({ timestamp: String(now - 1000) })));
      expect(processed[0]?.message.metadata.dateSent.getTime()).toBe(now - 1000);
    });

    it("dispatches a redelivered message only once", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(webhookRequest(userEvent()));
      await adapter.handleWebhook(webhookRequest(userEvent()));
      expect(processed).toHaveLength(1);
    });

    it("exposes an image as a downloadable attachment", async () => {
      const bytes = Buffer.from([1, 2, 3]);
      const fetchImpl = vi.fn(
        async () =>
          ({ ok: true, status: 200, arrayBuffer: async () => bytes }) as unknown as Response,
      );
      const { adapter, processed } = await initialized(fetchImpl);
      const url = "http://f6.photo.talk.zdn.vn/9c2db3ccc0a223fc7ab3.jpg";
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_image",
            message: {
              msg_id: "img_1",
              attachments: [{ type: "image", payload: { url, thumbnail: url } }],
            },
          }),
        ),
      );

      const message = processed[0]?.message as Message<ZaloOaRawMessage>;
      expect(message.text).toBe("");
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toMatchObject({ type: "image", url });
      await expect(message.attachments[0]?.fetchData?.()).resolves.toEqual(bytes);
      expect(fetchImpl).toHaveBeenCalledWith(url);
    });

    it.each([
      ["gif", "image", "image/gif"],
      ["sticker", "image", undefined],
      ["video", "video", undefined],
      ["audio", "audio", undefined],
    ])("maps a %s attachment to %s", async (zaloType, kind, mimeType) => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: `user_send_${zaloType}`,
            message: {
              msg_id: "m",
              attachments: [{ type: zaloType, payload: { url: "https://x/y" } }],
            },
          }),
        ),
      );
      expect(processed[0]?.message.attachments[0]).toMatchObject({ type: kind, mimeType });
    });

    it("does not mistake an inherited name for an attachment type", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_file",
            message: {
              msg_id: "proto",
              text: "x",
              attachments: [{ type: "constructor", payload: { url: "https://x/y" } }],
            },
          }),
        ),
      );
      expect(processed[0]?.message.attachments).toEqual([]);
    });

    it("gives an inbound document the MIME type of its extension", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_file",
            message: {
              msg_id: "f",
              attachments: [
                { type: "file", payload: { url: "https://x/f", name: "a.docx", type: "DOCX" } },
              ],
            },
          }),
        ),
      );
      expect(processed[0]?.message.attachments[0]?.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    });

    it("keeps a file's name and size", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_file",
            message: {
              msg_id: "f",
              attachments: [
                { type: "file", payload: { url: "https://x/f", name: "a.docx", size: "233947" } },
              ],
            },
          }),
        ),
      );
      expect(processed[0]?.message.attachments[0]).toMatchObject({
        type: "file",
        name: "a.docx",
        size: 233_947,
      });
    });

    it("renders a link or a location as text, since there is nothing to download", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_location",
            message: {
              msg_id: "loc",
              attachments: [
                {
                  type: "location",
                  payload: { coordinates: { latitude: "10.7", longitude: "106.6" } },
                },
              ],
            },
          }),
        ),
      );
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_link",
            message: {
              msg_id: "link",
              attachments: [{ type: "link", payload: { url: "https://developers.zalo.me/" } }],
            },
          }),
        ),
      );

      expect(processed.map((entry) => entry.message.text)).toEqual([
        "[location: 10.7, 106.6]",
        "https://developers.zalo.me/",
      ]);
      expect(processed.every((entry) => entry.message.attachments.length === 0)).toBe(true);
    });

    it("accepts IDs sent as JSON numbers", async () => {
      // Docs show strings; a number compared strictly would fail the OA
      // ownership check and silently drop every message.
      const oaId = "607812198688816";
      const local = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "s",
        oaSecretKey: OA_SECRET,
        oaId,
        accessToken: "a",
        refreshToken: "r",
      });
      const { chat, processed } = attachChat();
      await local.initialize(chat as never);

      await local.handleWebhook(
        webhookRequest({
          ...userEvent(),
          sender: { id: 246845883529 },
          recipient: { id: Number(oaId) },
          message: { msg_id: 7, text: "hi" },
        }),
      );

      expect(processed[0]?.threadId).toBe(`zalo-oa:${oaId}:user:246845883529`);
      expect(processed[0]?.message.id).toBe("7");
    });

    it("ignores an event whose name is not a string", async () => {
      const { adapter, processed, logger } = await initialized();
      const response = await adapter.handleWebhook(
        webhookRequest({ ...userEvent(), event_name: 42 }),
      );
      expect(response.status).toBe(200);
      expect(processed).toHaveLength(0);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("ignores the OA's own echoes", async () => {
      const { adapter, processed } = await initialized();
      const response = await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "oa_send_text",
            sender: { id: OA_ID, admin_id: "4267886274574868951" },
            recipient: { id: USER_ID },
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(processed).toHaveLength(0);
    });

    it("ignores other events", async () => {
      const { adapter, processed } = await initialized();
      const response = await adapter.handleWebhook(
        webhookRequest(userEvent({ event_name: "follow" })),
      );
      expect(response.status).toBe(200);
      expect(processed).toHaveLength(0);
    });

    it("refuses a message addressed to a different OA", async () => {
      const { adapter, processed, logger } = await initialized();
      await adapter.handleWebhook(webhookRequest(userEvent({ recipient: { id: "999" } })));
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA webhook for a different Official Account",
        { event: "user_send_text" },
      );
    });

    it("warns about a message with no ID", async () => {
      const { adapter, processed, logger } = await initialized();
      await adapter.handleWebhook(webhookRequest(userEvent({ message: { text: "hi" } })));
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA message with no ID, sender or conversation",
        expect.objectContaining({ messageId: "" }),
      );
    });

    it("logs an error for a message that arrives before initialize()", async () => {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const local = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "s",
        oaSecretKey: OA_SECRET,
        oaId: OA_ID,
        accessToken: "a",
        refreshToken: "r",
        logger: logger as never,
      });
      const response = await local.handleWebhook(webhookRequest(userEvent()));
      expect(response.status).toBe(200);
      expect(logger.error).toHaveBeenCalledWith(
        "Zalo OA adapter received a message before initialize() was called",
        { messageId: "msg_1" },
      );
    });

    it("answers 200 and logs when processing throws", async () => {
      const { adapter, chat, logger } = await initialized();
      chat.processMessage.mockImplementation(() => {
        throw new Error("boom");
      });
      const response = await adapter.handleWebhook(webhookRequest(userEvent()));
      expect(response.status).toBe(200);
      expect(logger.error).toHaveBeenCalledWith("Failed to process Zalo OA webhook", {
        error: expect.any(Error),
        event: "user_send_text",
      });
    });

    it("warns and falls back to now for an unusable timestamp", async () => {
      const { adapter, logger } = await initialized();
      const before = Date.now();
      const message = adapter.parseMessage(userEvent({ timestamp: "0" }));
      expect(message.metadata.dateSent.getTime()).toBeGreaterThanOrEqual(before);
      expect(logger.warn).toHaveBeenCalledWith(
        "Zalo sent an unusable timestamp; substituting a fallback",
        { field: "webhook", value: "0" },
      );
    });

    it("parses a payload whose event_name is not a string as a one-to-one message", async () => {
      const { adapter } = await initialized();
      // parseMessage() is public; a stored payload with a mangled event
      // name must still decode rather than crash on `.startsWith`.
      const message = adapter.parseMessage(userEvent({ event_name: 7 as never }));
      expect(message.threadId).toBe(THREAD_ID);
      expect(message.isMention).toBeUndefined();
    });
  });

  describe("sending", () => {
    let adapter: ZaloOaAdapter;
    let fetchImpl: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchImpl = vi.fn(async () =>
        ok({ message_id: "sent_1", user_id: USER_ID, sent_time: String(T0) }),
      );
      ({ adapter } = build(fetchImpl));
    });

    it("posts a consultation text message", async () => {
      const result = await adapter.postMessage(THREAD_ID, "Xin chào");

      expect(result.id).toBe("sent_1");
      expect(result.threadId).toBe(THREAD_ID);
      const { url, init, body } = lastCall(fetchImpl);
      expect(url.href).toBe("https://openapi.zalo.me/v3.0/oa/message/cs");
      expect((init.headers as Record<string, string>).access_token).toBe("acc_1");
      expect(body).toEqual({ recipient: { user_id: USER_ID }, message: { text: "Xin chào" } });
    });

    it("flattens markdown to plain text", async () => {
      await adapter.postMessage(THREAD_ID, { markdown: "**bold** and _it_" });
      expect(lastCall(fetchImpl).body.message.text).toBe("bold and it");
    });

    it("quotes the message it replies to", async () => {
      await adapter.reply(THREAD_ID, "48687128d04c9410cd5f", "Our address is 182 Le Dai Hanh");
      expect(lastCall(fetchImpl).body).toEqual({
        recipient: { user_id: USER_ID },
        message: {
          text: "Our address is 182 Le Dai Hanh",
          quote_message_id: "48687128d04c9410cd5f",
        },
      });
    });

    it("refuses an empty reply target", async () => {
      await expect(adapter.reply(THREAD_ID, "", "x")).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses an empty message without a request", async () => {
      await expect(adapter.postMessage(THREAD_ID, "   ")).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("accepts exactly 2000 characters and refuses 2001", async () => {
      await expect(adapter.postMessage(THREAD_ID, "a".repeat(2000))).resolves.toBeDefined();
      await expect(adapter.postMessage(THREAD_ID, "a".repeat(2001))).rejects.toThrow(
        /at most 2000/,
      );
    });

    it("refuses a thread of a different OA", async () => {
      await expect(adapter.postMessage(`zalo-oa:111:user:${USER_ID}`, "hi")).rejects.toThrow(
        /different Official Account/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("surfaces an expired interaction window as a ValidationError", async () => {
      fetchImpl.mockResolvedValue(fail(ZALO_OA_ERROR.NO_RECENT_INTERACTION));
      await expect(adapter.postMessage(THREAD_ID, "hi")).rejects.toBeInstanceOf(ValidationError);
    });

    it("reports a numeric message_id as a string", async () => {
      fetchImpl.mockResolvedValue(ok({ message_id: 123456, user_id: USER_ID }));
      const result = await adapter.postMessage(THREAD_ID, "hi");
      expect(result.id).toBe("123456");
    });

    it("treats success without a message_id as unconfirmed", async () => {
      fetchImpl.mockResolvedValue(ok({ user_id: USER_ID }));
      await expect(adapter.postMessage(THREAD_ID, "hi")).rejects.toBeInstanceOf(NetworkError);
    });

    it("parses its own send result as a message from the bot", () => {
      const message = adapter.parseMessage({
        message_id: "sent_1",
        user_id: USER_ID,
        sent_time: String(T0),
      });
      expect(message.threadId).toBe(THREAD_ID);
      expect(message.author.isMe).toBe(true);
      expect(message.metadata.dateSent.getTime()).toBe(T0);
    });

    it("treats typing as a no-op", async () => {
      await expect(adapter.startTyping(THREAD_ID)).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("history", () => {
    function history(overrides: Partial<ZaloOaHistoryMessage> = {}): ZaloOaHistoryMessage {
      return {
        message_id: "h1",
        src: 1,
        time: T0,
        type: "text",
        message: "from history",
        from_id: USER_ID,
        to_id: OA_ID,
        from_display_name: "Ana",
        ...overrides,
      };
    }

    it("requests a page by offset and returns it oldest first", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([
          history({ message_id: "newer", time: T0 + 2000 }),
          history({ message_id: "older", time: T0 + 1000, src: 0, from_id: OA_ID, to_id: USER_ID }),
        ]),
      );
      const { adapter } = build(fetchImpl);

      const result = await adapter.fetchMessages(THREAD_ID, { limit: 2 });

      const { url } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v2.0/oa/conversation");
      expect(JSON.parse(url.searchParams.get("data") as string)).toEqual({
        user_id: USER_ID,
        offset: 0,
        count: 2,
      });
      expect(result.messages.map((message) => message.id)).toEqual(["older", "newer"]);
      expect(result.messages[0]?.author.isMe).toBe(true);
      expect(result.messages[1]?.author).toMatchObject({ userId: USER_ID, fullName: "Ana" });
      expect(result.messages.every((message) => message.threadId === THREAD_ID)).toBe(true);
      // A full page means there may be more.
      expect(result.nextCursor).toBe("2");
    });

    it("pages ten at a time up to the limit and resumes from the cursor", async () => {
      const page = (start: number, count: number) =>
        Array.from({ length: count }, (_, i) =>
          history({ message_id: `m${start + i}`, time: T0 - (start + i) * 1000 }),
        );
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(ok(page(5, 10)))
        .mockResolvedValueOnce(ok(page(15, 5)));
      const { adapter } = build(fetchImpl);

      const result = await adapter.fetchMessages(THREAD_ID, { cursor: "5", limit: 15 });

      const offsets = fetchImpl.mock.calls.map((call) => {
        const data = new URL((call as unknown as [string])[0]).searchParams.get("data");
        return JSON.parse(data as string);
      });
      expect(offsets).toEqual([
        { user_id: USER_ID, offset: 5, count: 10 },
        { user_id: USER_ID, offset: 15, count: 5 },
      ]);
      expect(result.messages).toHaveLength(15);
      expect(result.nextCursor).toBe("20");
    });

    it("stops at a short page and reports no further cursor", async () => {
      const fetchImpl = vi.fn(async () => ok([history()]));
      const { adapter } = build(fetchImpl);
      const result = await adapter.fetchMessages(THREAD_ID, { limit: 10 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.nextCursor).toBeUndefined();
    });

    it("returns nothing for limit 0 without a request", async () => {
      const fetchImpl = vi.fn();
      const { adapter } = build(fetchImpl);
      await expect(adapter.fetchMessages(THREAD_ID, { limit: 0 })).resolves.toEqual({
        messages: [],
        nextCursor: undefined,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each(["-1", "1.5", "abc"])("rejects the cursor %s", async (cursor) => {
      const { adapter } = build();
      await expect(adapter.fetchMessages(THREAD_ID, { cursor })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("refuses forward paging", async () => {
      const { adapter } = build();
      await expect(
        adapter.fetchMessages(THREAD_ID, { direction: "forward" }),
      ).rejects.toBeInstanceOf(NotImplementedError);
    });

    it("does not mistake an inherited name for a history attachment type", () => {
      const { adapter } = build();
      const message = adapter.parseMessage(history({ type: "constructor", url: "https://x/y" }));
      expect(message.attachments).toEqual([]);
    });

    it("exposes photos and voice notes as attachments", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([
          history({ message_id: "p", type: "photo", message: "", url: "https://x/p.jpg" }),
          history({
            message_id: "v",
            type: "voice",
            message: "",
            url: "https://x/v.amr",
            time: T0 + 1,
          }),
        ]),
      );
      const { adapter } = build(fetchImpl);
      const { messages } = await adapter.fetchMessages(THREAD_ID);
      expect(messages.map((message) => message.attachments[0]?.type)).toEqual(["image", "audio"]);
    });

    it("renders shared links as text", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([history({ type: "links", message: "", links: ["https://a", "https://b"] })]),
      );
      const { adapter } = build(fetchImpl);
      const { messages } = await adapter.fetchMessages(THREAD_ID);
      expect(messages[0]?.text).toBe("https://a\nhttps://b");
    });

    it("dates an undated entry beside its newer neighbour", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([
          history({ message_id: "newest", time: T0 + 2000 }),
          history({ message_id: "undated", time: 0 }),
          history({ message_id: "oldest", time: T0 }),
        ]),
      );
      const { adapter } = build(fetchImpl);
      const { messages } = await adapter.fetchMessages(THREAD_ID);
      // Zalo listed it between the two, so that is where it stays: it takes
      // its newer neighbour's stamp, and the tie keeps it before that neighbour.
      expect(messages.map((message) => message.id)).toEqual(["oldest", "undated", "newest"]);
      expect(messages[1]?.metadata.dateSent.getTime()).toBe(T0 + 2000);
    });

    it("keeps messages that share a timestamp in the order they were sent", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([
          history({ message_id: "second", time: T0 }),
          history({ message_id: "first", time: T0 }),
        ]),
      );
      const { adapter } = build(fetchImpl);
      const { messages } = await adapter.fetchMessages(THREAD_ID);
      expect(messages.map((message) => message.id)).toEqual(["first", "second"]);
    });

    it("files every entry under the thread that was read, not the IDs in the entry", async () => {
      // An 18-digit ID sent as a JSON number loses precision when parsed;
      // deriving the user from it would file the message under someone else.
      const fetchImpl = vi.fn(async () =>
        ok([
          history({ message_id: "a", from_id: 246845883529197900, to_id: OA_ID }),
          history({ message_id: "b", src: 0, from_id: OA_ID, to_id: undefined as never }),
        ]),
      );
      const { adapter } = build(fetchImpl);
      const { messages } = await adapter.fetchMessages(THREAD_ID);
      expect(messages.map((message) => message.threadId)).toEqual([THREAD_ID, THREAD_ID]);
      expect(messages.find((message) => message.id === "a")?.author.userId).toBe(USER_ID);
    });

    it("reads src given as a string", () => {
      const { adapter } = build();
      const message = adapter.parseMessage(history({ src: "1" as never }));
      expect(message.author.isMe).toBe(false);
    });

    it("refuses to parse a standalone entry that names no user", () => {
      const { adapter } = build();
      expect(() => adapter.parseMessage(history({ src: 1, from_id: undefined as never }))).toThrow(
        ValidationError,
      );
    });

    it.each(["", " 5", "5 "])("rejects the cursor %j", async (cursor) => {
      const fetchImpl = vi.fn();
      const { adapter } = build(fetchImpl);
      await expect(adapter.fetchMessages(THREAD_ID, { cursor })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects the limit %s", async (limit) => {
      const { adapter } = build();
      await expect(adapter.fetchMessages(THREAD_ID, { limit })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("sends a whole count for a fractional limit", async () => {
      const fetchImpl = vi.fn(async () => ok([history()]));
      const { adapter } = build(fetchImpl);
      await adapter.fetchMessages(THREAD_ID, { limit: 2.7 });
      const data = JSON.parse(lastCall(fetchImpl).url.searchParams.get("data") as string);
      expect(data.count).toBe(2);
    });
  });

  describe("channel and users", () => {
    it("reads the OA profile for its own channel", async () => {
      const fetchImpl = vi.fn(async () =>
        ok({ oaid: OA_ID, name: "Acme", oa_alias: "acme", is_verified: true, num_follower: 5 }),
      );
      const { adapter } = build(fetchImpl);
      const info = await adapter.fetchChannelInfo(`zalo-oa:${OA_ID}`);

      expect(lastCall(fetchImpl).url.pathname).toBe("/v2.0/oa/getoa");
      expect(info).toMatchObject({
        id: `zalo-oa:${OA_ID}`,
        name: "Acme",
        metadata: { alias: "acme", isVerified: true, followers: 5 },
      });
    });

    it("refuses another OA's channel without a request", async () => {
      const fetchImpl = vi.fn();
      const { adapter } = build(fetchImpl);
      await expect(adapter.fetchChannelInfo("zalo-oa:111")).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("looks up a user's profile", async () => {
      const fetchImpl = vi.fn(async () =>
        ok({ user_id: USER_ID, display_name: "Ana", user_alias: "ana_k", avatar: "https://a" }),
      );
      const { adapter } = build(fetchImpl);
      const user = await adapter.getUser(USER_ID);

      const { url } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/user/detail");
      expect(JSON.parse(url.searchParams.get("data") as string)).toEqual({ user_id: USER_ID });
      expect(user).toEqual({
        userId: USER_ID,
        userName: "ana_k",
        fullName: "Ana",
        isBot: false,
        avatarUrl: "https://a",
      });
    });

    it("refuses an empty user ID without a request", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.getUser(" ")).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("attachments", () => {
    it("restores fetchData on a serialized attachment", async () => {
      const bytes = Buffer.from([9]);
      const fetchImpl = vi.fn(
        async () =>
          ({ ok: true, status: 200, arrayBuffer: async () => bytes }) as unknown as Response,
      );
      const { adapter } = build(fetchImpl);
      const restored = adapter.rehydrateAttachment({ type: "image", url: "https://x/a.jpg" });
      await expect(restored.fetchData?.()).resolves.toEqual(bytes);
    });

    it.each(["file:///etc/passwd", "data:text/plain,hi", "ftp://x/y", "javascript:alert(1)"])(
      "refuses to download %s without fetching",
      async (url) => {
        const fetchImpl = vi.fn();
        const { adapter } = build(fetchImpl);
        const restored = adapter.rehydrateAttachment({ type: "file", url });
        await expect(restored.fetchData?.()).rejects.toBeInstanceOf(ValidationError);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it("leaves an attachment without a URL alone", () => {
      const { adapter } = build();
      const attachment = { type: "file" as const, name: "a" };
      expect(adapter.rehydrateAttachment(attachment)).toBe(attachment);
    });

    it("refuses an attachment whose declared size exceeds the cap, before reading it", async () => {
      const arrayBuffer = vi.fn();
      const fetchImpl = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ "content-length": String(50 * 1024 * 1024 + 1) }),
            arrayBuffer,
          }) as unknown as Response,
      );
      const { adapter } = build(fetchImpl);
      const restored = adapter.rehydrateAttachment({ type: "video", url: "https://x/big" });
      await expect(restored.fetchData?.()).rejects.toThrow(/maxDownloadBytes/);
      expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it("refuses an undeclared body that turns out too large", async () => {
      const fetchImpl = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new Uint8Array(11).buffer,
          }) as unknown as Response,
      );
      const adapter = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "s",
        oaSecretKey: OA_SECRET,
        oaId: OA_ID,
        accessToken: "a",
        refreshToken: "r",
        maxDownloadBytes: 10,
        fetchImpl: fetchImpl as never,
      });
      const restored = adapter.rehydrateAttachment({ type: "file", url: "https://x/f" });
      await expect(restored.fetchData?.()).rejects.toBeInstanceOf(ValidationError);
    });

    it("reports a failed download as a NetworkError", async () => {
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
      const { adapter } = build(fetchImpl);
      const restored = adapter.rehydrateAttachment({ type: "image", url: "https://x/gone" });
      await expect(restored.fetchData?.()).rejects.toThrow(/HTTP 404/);
    });
  });

  describe("sending media", () => {
    it("uploads an image and sends it with its caption", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);

      const result = await adapter.postMessage(THREAD_ID, {
        markdown: "**New** arrivals",
        files: [{ data: PNG, filename: "a.png", mimeType: "image/png" }],
      });

      expect(result.id).toBe("sent_1");
      const [uploadUrl, uploadInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(uploadUrl).toBe("https://openapi.zalo.me/v2.0/oa/upload/image");
      const form = uploadInit.body as FormData;
      const file = form.get("file") as File;
      expect(file.name).toBe("a.png");
      expect(file.type).toBe("image/png");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
      // The runtime must set the multipart boundary itself.
      expect(uploadInit.headers).toEqual({ access_token: "acc_1" });

      expect(sentBody(fetchImpl)).toEqual({
        recipient: { user_id: USER_ID },
        message: {
          text: "New arrivals",
          attachment: {
            type: "template",
            payload: {
              template_type: "media",
              elements: [{ media_type: "image", attachment_id: "att_1" }],
            },
          },
        },
      });
    });

    it("sends an image without a caption when there is no text", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(THREAD_ID, { raw: "", files: [{ data: PNG, filename: "a.png" }] });
      expect(sentBody(fetchImpl).message).not.toHaveProperty("text");
    });

    it("sends a GIF with the dimensions read from its header", async () => {
      const fetchImpl = mediaFetch({ token: "gif_1" });
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(THREAD_ID, { raw: "", files: [{ data: GIF, filename: "a.gif" }] });

      expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://openapi.zalo.me/v2.0/oa/upload/gif");
      expect(sentBody(fetchImpl).message.attachment.payload.elements).toEqual([
        { media_type: "gif", attachment_id: "gif_1", width: 320, height: 240 },
      ]);
    });

    it("uploads a document and sends it by token", async () => {
      const fetchImpl = mediaFetch({ token: "file_tok" });
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(THREAD_ID, { raw: "", files: [{ data: PDF, filename: "q3.pdf" }] });

      expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://openapi.zalo.me/v2.0/oa/upload/file");
      expect(sentBody(fetchImpl)).toEqual({
        recipient: { user_id: USER_ID },
        message: { attachment: { type: "file", payload: { token: "file_tok" } } },
      });
    });

    it("refuses text with a file before uploading", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await expect(
        adapter.postMessage(THREAD_ID, {
          markdown: "Your report",
          files: [{ data: PDF, filename: "q3.pdf" }],
        }),
      ).rejects.toThrow(/cannot attach text to a file/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses several attachments before uploading", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await expect(
        adapter.postMessage(THREAD_ID, {
          raw: "",
          files: [
            { data: PNG, filename: "a.png" },
            { data: PNG, filename: "b.png" },
          ],
        }),
      ).rejects.toThrow(/one attachment per message; got 2/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses an unsupported type before uploading", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await expect(
        adapter.postMessage(THREAD_ID, {
          raw: "",
          files: [{ data: Buffer.from("RIFF0000WEBP"), filename: "a.webp" }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses an over-long caption before uploading", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await expect(
        adapter.postMessage(THREAD_ID, {
          raw: "a".repeat(2001),
          files: [{ data: PNG, filename: "a.png" }],
        }),
      ).rejects.toThrow(/caption is 2001/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("accepts a Blob or an ArrayBuffer as the file data", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(THREAD_ID, {
        raw: "",
        files: [{ data: new Blob([new Uint8Array(PNG)]), filename: "a.png" }],
      });
      const ab = PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
      await adapter.postMessage(THREAD_ID, {
        raw: "",
        files: [{ data: ab as ArrayBuffer, filename: "b.png" }],
      });
      expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/upload/"))).toHaveLength(2);
    });

    it("refuses a file in a quoted reply", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      await expect(
        adapter.reply(THREAD_ID, "m1", { raw: "", files: [{ data: PNG, filename: "a.png" }] }),
      ).rejects.toThrow(/quotes only text/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("sends a sticker by ID", async () => {
      const fetchImpl = mediaFetch();
      const { adapter } = build(fetchImpl);
      const result = await adapter.sendSticker(THREAD_ID, "bfe458bf64fa8da4d4eb");

      expect(result.id).toBe("sent_1");
      expect(sentBody(fetchImpl)).toEqual({
        recipient: { user_id: USER_ID },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "media",
              elements: [{ media_type: "sticker", attachment_id: "bfe458bf64fa8da4d4eb" }],
            },
          },
        },
      });
    });

    it("refuses an empty sticker ID", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.sendSticker(THREAD_ID, "  ")).rejects.toBeInstanceOf(ValidationError);
      // What getStickerId() returns for a message that carried no sticker.
      await expect(adapter.sendSticker(THREAD_ID, undefined as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("reactions", () => {
    it.each([
      ["a well-known emoji", emoji.heart, "/-heart"],
      ["a well-known name", "thumbs_up", "/-strong"],
      ["a Zalo icon code", "--b", "--b"],
    ])("reacts with %s", async (_label, value, icon) => {
      const { adapter, fetchImpl } = build();
      await adapter.addReaction(THREAD_ID, "789f573aecf8a9a4f0eb", value);

      const { url, body } = lastCall(fetchImpl);
      expect(url.href).toBe("https://openapi.zalo.me/v2.0/oa/message");
      expect(body).toEqual({
        recipient: { user_id: USER_ID },
        sender_action: { react_icon: icon, react_message_id: "789f573aecf8a9a4f0eb" },
      });
    });

    it("reacts with a Unicode emoji", async () => {
      const { adapter, fetchImpl } = build();
      await adapter.addReaction(THREAD_ID, "m1", "👍");
      expect(lastCall(fetchImpl).body.sender_action.react_icon).toBe("/-strong");
    });

    it("refuses an inherited property name as a reaction", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.addReaction(THREAD_ID, "m1", "toString")).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses an emoji Zalo does not offer, naming the ones it does", async () => {
      const { adapter, fetchImpl } = build();
      const failure = adapter.addReaction(THREAD_ID, "m", emoji.rocket);
      await expect(failure).rejects.toBeInstanceOf(ValidationError);
      await expect(failure).rejects.toThrow(/no "rocket" reaction.*heart \(\/-heart\)/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("withdraws with /-remove", async () => {
      const { adapter, fetchImpl } = build();
      await adapter.removeReaction(THREAD_ID, "m1", emoji.heart);
      expect(lastCall(fetchImpl).body.sender_action).toEqual({
        react_icon: "/-remove",
        react_message_id: "m1",
      });
    });

    it("checks the emoji even when withdrawing", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.removeReaction(THREAD_ID, "m1", "hart")).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses a reaction without a message ID", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.addReaction(THREAD_ID, "", "heart")).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    function reactionEvent(icon: string, overrides: Partial<ZaloOaWebhookEvent> = {}) {
      return userEvent({
        event_name: "user_reacted_message",
        message: { msg_id: "789f573aecf8a9a4f0eb", react_icon: icon },
        ...overrides,
      });
    }

    it("delivers a user's reaction as a reaction event", async () => {
      const { adapter, chat } = await initialized();
      const options = { waitUntil: vi.fn() };
      const event = reactionEvent("/-heart");
      const response = await adapter.handleWebhook(webhookRequest(event), options);

      expect(response.status).toBe(200);
      expect(chat.processReaction).toHaveBeenCalledTimes(1);
      const [delivered, passed] = chat.processReaction.mock.calls[0] as [
        Record<string, unknown>,
        unknown,
      ];
      expect(passed).toBe(options);
      expect(delivered).toMatchObject({
        adapter,
        added: true,
        rawEmoji: "/-heart",
        messageId: "789f573aecf8a9a4f0eb",
        threadId: THREAD_ID,
        user: { userId: USER_ID, isMe: false, isBot: false },
        raw: event,
      });
      expect((delivered.emoji as { name: string }).name).toBe("heart");
    });

    it("delivers --b as a custom emoji under its own code", async () => {
      const { adapter, chat } = await initialized();
      await adapter.handleWebhook(webhookRequest(reactionEvent("--b")));
      const [delivered] = chat.processReaction.mock.calls[0] as [Record<string, unknown>];
      expect((delivered.emoji as { name: string }).name).toBe("--b");
    });

    it("delivers a withdrawal as added: false", async () => {
      const { adapter, chat } = await initialized();
      await adapter.handleWebhook(webhookRequest(reactionEvent("/-remove")));
      expect(chat.processReaction.mock.calls[0]?.[0]).toMatchObject({
        added: false,
        rawEmoji: "/-remove",
      });
    });

    it("delivers a redelivered reaction once, but a repeat reaction again", async () => {
      const { adapter, chat } = await initialized();
      const first = reactionEvent("/-heart", { timestamp: String(Date.now() - 2000) });
      await adapter.handleWebhook(webhookRequest(first));
      await adapter.handleWebhook(webhookRequest(first));
      await adapter.handleWebhook(
        webhookRequest(reactionEvent("/-heart", { timestamp: String(Date.now()) })),
      );
      expect(chat.processReaction).toHaveBeenCalledTimes(2);
    });

    it("ignores the OA's own reaction echo", async () => {
      const { adapter, chat, processed, logger } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          reactionEvent("/-heart", {
            event_name: "oa_reacted_message",
            sender: { id: OA_ID },
            recipient: { id: USER_ID },
          }),
        ),
      );
      expect(chat.processReaction).not.toHaveBeenCalled();
      expect(processed).toHaveLength(0);
      expect(logger.debug).toHaveBeenCalledWith("Ignoring a Zalo OA echo", {
        event: "oa_reacted_message",
      });
    });

    it("refuses a reaction addressed to a different OA", async () => {
      const { adapter, chat, logger } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(reactionEvent("/-heart", { recipient: { id: "9" } })),
      );
      expect(chat.processReaction).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA webhook for a different Official Account",
        { event: "user_reacted_message" },
      );
    });

    it("warns about a reaction with no icon", async () => {
      const { adapter, chat, logger } = await initialized();
      await adapter.handleWebhook(webhookRequest(reactionEvent("", { message: { msg_id: "m" } })));
      expect(chat.processReaction).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA reaction with no message, sender or icon",
        { messageId: "m", userId: USER_ID, icon: "" },
      );
    });

    it("logs a reaction that arrives before initialize()", async () => {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const local = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "s",
        oaSecretKey: OA_SECRET,
        oaId: OA_ID,
        accessToken: "a",
        refreshToken: "r",
        logger: logger as never,
      });
      await local.handleWebhook(webhookRequest(reactionEvent("/-heart")));
      expect(logger.error).toHaveBeenCalledWith(
        "Zalo OA adapter received a reaction before initialize() was called",
        { messageId: "789f573aecf8a9a4f0eb" },
      );
    });
  });

  describe("stickers", () => {
    it("reads the ID of a sticker a user sent", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          userEvent({
            event_name: "user_send_sticker",
            message: {
              msg_id: "s1",
              attachments: [
                { type: "sticker", payload: { id: "e1540df031b5deb81a4", url: "https://x/s" } },
              ],
            },
          }),
        ),
      );
      expect(getStickerId(processed[0]?.message.raw)).toBe("e1540df031b5deb81a4");
    });

    it.each([null, undefined, "text", 5, {}, { event_name: "x", message: { attachments: "no" } }])(
      "finds no sticker in the malformed raw value %j",
      (raw) => {
        expect(getStickerId(raw)).toBeUndefined();
      },
    );

    it("ignores a sticker ID that is not a string", () => {
      const event = userEvent({
        event_name: "user_send_sticker",
        message: { msg_id: "s", attachments: [{ type: "sticker", payload: { id: 7 as never } }] },
      });
      expect(getStickerId(event)).toBeUndefined();
    });

    it("finds no sticker in a text message or a history entry", () => {
      expect(getStickerId(userEvent())).toBeUndefined();
      expect(
        getStickerId({
          message_id: "h",
          src: 1,
          time: T0,
          type: "sticker",
          url: "https://x/s",
          from_id: USER_ID,
          to_id: OA_ID,
        }),
      ).toBeUndefined();
    });
  });

  describe("group chats", () => {
    const GROUP_ID = "f414c8f76fa586fbdfb4";
    const GROUP_THREAD = `zalo-oa:${OA_ID}:group:${GROUP_ID}`;

    function groupEvent(overrides: Partial<ZaloOaWebhookEvent> = {}): ZaloOaWebhookEvent {
      return userEvent({
        event_name: "user_send_group_text",
        sender: { id: "8756287263669629130" },
        recipient: { id: GROUP_ID },
        oa_id: OA_ID,
        message: { msg_id: "g1", text: "Hello group from User" },
        ...overrides,
      });
    }

    it("dispatches a group message to the group's thread", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(webhookRequest(groupEvent()));

      expect(processed).toHaveLength(1);
      const { threadId, message } = processed[0] as (typeof processed)[number];
      expect(threadId).toBe(GROUP_THREAD);
      expect(message.threadId).toBe(GROUP_THREAD);
      expect(message.author.userId).toBe("8756287263669629130");
      expect(message.text).toBe("Hello group from User");
      expect(adapter.isDM(threadId)).toBe(false);
    });

    it("checks ownership against oa_id, since the recipient is the group", async () => {
      const { adapter, processed, logger } = await initialized();
      await adapter.handleWebhook(webhookRequest(groupEvent({ oa_id: "999" })));
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA webhook for a different Official Account",
        { event: "user_send_group_text" },
      );
    });

    it("refuses a group event that names no OA", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(webhookRequest(groupEvent({ oa_id: undefined })));
      expect(processed).toHaveLength(0);
    });

    it("accepts the message ID under message_id, as the field table names it", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(groupEvent({ message: { message_id: "g2", text: "hi" } })),
      );
      expect(processed[0]?.message.id).toBe("g2");
    });

    it("refuses a group event with no group", async () => {
      const { adapter, processed, logger } = await initialized();
      await adapter.handleWebhook(webhookRequest(groupEvent({ recipient: { id: "" } })));
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA message with no ID, sender or conversation",
        expect.objectContaining({ event: "user_send_group_text" }),
      );
    });

    it("marks a message that mentions the OA, and only that", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(groupEvent({ message: { msg_id: "a", text: `hi [@${OA_ID}]` } })),
      );
      await adapter.handleWebhook(
        webhookRequest(groupEvent({ message: { msg_id: "b", text: `all [@${GROUP_ID}]` } })),
      );
      await adapter.handleWebhook(
        webhookRequest(groupEvent({ message: { msg_id: "c", text: "plain" } })),
      );
      expect(processed.map((entry) => entry.message.isMention)).toEqual([true, false, false]);
    });

    it("leaves isMention to the SDK in one-to-one conversations", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(webhookRequest(userEvent()));
      expect(processed[0]?.message.isMention).toBeUndefined();
    });

    it("ignores the OA's own group echoes", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(groupEvent({ event_name: "oa_send_group_text", sender: { id: OA_ID } })),
      );
      expect(processed).toHaveLength(0);
    });

    it("posts text to the group endpoint", async () => {
      const fetchImpl = vi.fn(async () => ok({ message_id: "gm1", group_id: GROUP_ID }));
      const { adapter } = build(fetchImpl);
      const result = await adapter.postMessage(GROUP_THREAD, `hello [@${USER_ID}]`);

      expect(result).toMatchObject({ id: "gm1", threadId: GROUP_THREAD });
      const { url, body } = lastCall(fetchImpl);
      expect(url.href).toBe("https://openapi.zalo.me/v3.0/oa/group/message");
      expect(body).toEqual({
        recipient: { group_id: GROUP_ID },
        message: { text: `hello [@${USER_ID}]` },
      });
    });

    it("sends a group image with an empty caption, which the group API requires", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        url.includes("/upload/")
          ? ok({ attachment_id: "att" })
          : ok({ message_id: "gm", group_id: GROUP_ID }),
      );
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(GROUP_THREAD, {
        raw: "",
        files: [{ data: PNG, filename: "a.png" }],
      });

      const { url, body } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/message");
      expect(body.message.text).toBe("");
      expect(body.message.attachment.payload.elements).toEqual([
        { media_type: "image", attachment_id: "att" },
      ]);
    });

    it("sends a group file and a group sticker", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        url.includes("/upload/")
          ? ok({ token: "tok" })
          : ok({ message_id: "gm", group_id: GROUP_ID }),
      );
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(GROUP_THREAD, {
        raw: "",
        files: [{ data: PDF, filename: "a.pdf" }],
      });
      expect(lastCall(fetchImpl).body).toEqual({
        recipient: { group_id: GROUP_ID },
        message: { attachment: { type: "file", payload: { token: "tok" } } },
      });

      await adapter.sendSticker(GROUP_THREAD, "st1");
      expect(lastCall(fetchImpl).body.recipient).toEqual({ group_id: GROUP_ID });
    });

    it.each([
      ["a quoted reply", (a: ZaloOaAdapter) => a.reply(GROUP_THREAD, "m", "x")],
      ["a reaction", (a: ZaloOaAdapter) => a.addReaction(GROUP_THREAD, "m", "heart")],
      ["a template", (a: ZaloOaAdapter) => a.sendTemplate(GROUP_THREAD, "1", {})],
    ])("refuses %s, which Zalo offers one to one only", async (_label, call) => {
      const { adapter, fetchImpl } = build();
      await expect(call(adapter)).rejects.toBeInstanceOf(NotImplementedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reads group history with plain parameters and attributes each sender", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([
          {
            src: 0,
            time: T0 + 1000,
            type: "text",
            message: "m4",
            message_id: "oa_msg",
            from_id: OA_ID,
            group_id: GROUP_ID,
          },
          {
            src: 1,
            time: T0,
            type: "photo",
            url: "https://x/p.jpg",
            message_id: "user_msg",
            from_id: "8756287263669629130",
            from_display_name: "Phuoc",
            group_id: GROUP_ID,
          },
        ]),
      );
      const { adapter } = build(fetchImpl);
      const { messages, nextCursor } = await adapter.fetchMessages(GROUP_THREAD, { limit: 2 });

      const { url } = lastCall(fetchImpl);
      expect(url.pathname).toBe("/v3.0/oa/group/conversation");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        group_id: GROUP_ID,
        offset: "0",
        count: "2",
      });
      expect(messages.map((m) => m.id)).toEqual(["user_msg", "oa_msg"]);
      expect(messages.every((m) => m.threadId === GROUP_THREAD)).toBe(true);
      expect(messages[0]?.author).toMatchObject({
        userId: "8756287263669629130",
        fullName: "Phuoc",
        isMe: false,
      });
      expect(messages[0]?.attachments[0]?.type).toBe("image");
      expect(messages[1]?.author.isMe).toBe(true);
      expect(nextCursor).toBe("2");
    });

    it("pages group history five at a time, the size Zalo documents", async () => {
      const entry = (i: number) => ({
        src: 1,
        time: T0 - i,
        type: "text",
        message: `m${i}`,
        message_id: `m${i}`,
        from_id: "7",
        group_id: GROUP_ID,
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(ok([0, 1, 2, 3, 4].map(entry)))
        .mockResolvedValueOnce(ok([5, 6, 7, 8, 9].map(entry)));
      const { adapter } = build(fetchImpl);

      const { messages, nextCursor } = await adapter.fetchMessages(GROUP_THREAD);

      const counts = fetchImpl.mock.calls.map((call) =>
        new URL((call as unknown as [string])[0]).searchParams.get("count"),
      );
      expect(counts).toEqual(["5", "5"]);
      expect(messages).toHaveLength(10);
      expect(nextCursor).toBe("10");
    });

    it("skips a group history entry whose sender is unnamed, keeping the rest", async () => {
      const fetchImpl = vi.fn(async () =>
        ok([
          {
            src: 1,
            time: T0 + 1,
            type: "text",
            message: "named",
            message_id: "a",
            from_id: "7",
            group_id: GROUP_ID,
          },
          {
            src: 1,
            time: T0,
            type: "text",
            message: "unnamed",
            message_id: "b",
            group_id: GROUP_ID,
          },
        ]),
      );
      const { adapter } = build(fetchImpl);
      const attached = attachChat();
      await adapter.initialize(attached.chat as never);
      const { messages } = await adapter.fetchMessages(GROUP_THREAD);
      expect(messages.map((m) => m.id)).toEqual(["a"]);
      expect(attached.logger.warn).toHaveBeenCalledWith(
        "Skipping an unreadable Zalo OA history entry",
        expect.objectContaining({ error: expect.any(ValidationError) }),
      );
    });

    it("files a standalone group history entry under its group", () => {
      const { adapter } = build();
      const message = adapter.parseMessage({
        src: 1,
        time: T0,
        type: "text",
        message: "x",
        message_id: "h",
        from_id: "7",
        to_id: "",
        group_id: GROUP_ID,
      });
      expect(message.threadId).toBe(GROUP_THREAD);
      expect(message.author.userId).toBe("7");
    });

    it("parses a group send result under the group", () => {
      const { adapter } = build();
      expect(adapter.parseMessage({ message_id: "s", group_id: GROUP_ID }).threadId).toBe(
        GROUP_THREAD,
      );
    });

    it("describes a group thread as not a DM", async () => {
      const { adapter } = build();
      await expect(adapter.fetchThread(GROUP_THREAD)).resolves.toMatchObject({ isDM: false });
    });

    it("refuses another OA's group", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.postMessage(`zalo-oa:111:group:${GROUP_ID}`, "hi")).rejects.toThrow(
        /different Official Account/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("templates", () => {
    it("sends a template by user ID", async () => {
      const fetchImpl = vi.fn(async () => ok({ message_id: "tm1", user_id: USER_ID }));
      const { adapter } = build(fetchImpl);
      const result = await adapter.sendTemplate(THREAD_ID, "433555", {
        customer: "Nguyễn Thị Hoàng Anh",
        total: 100000,
      });

      expect(result).toMatchObject({ id: "tm1", threadId: THREAD_ID });
      const { url, body } = lastCall(fetchImpl);
      expect(url.href).toBe("https://openapi.zalo.me/v3.0/oa/message/template");
      expect(body).toEqual({
        user_id: USER_ID,
        template_id: "433555",
        template_data: { customer: "Nguyễn Thị Hoàng Anh", total: 100000 },
      });
    });

    it("accepts a numeric template ID, as listTemplates reports them", async () => {
      const fetchImpl = vi.fn(async () => ok({ message_id: "tm", user_id: USER_ID }));
      const { adapter } = build(fetchImpl);
      await adapter.sendTemplate(THREAD_ID, 900025, { a: "1" });
      expect(lastCall(fetchImpl).body.template_id).toBe("900025");
    });

    it.each([
      ["an empty template ID", "  ", {}],
      // A JavaScript caller can pass these; String() would send "null".
      ["a null template ID", null as never, {}],
      ["an undefined template ID", undefined as never, {}],
      ["an array as data", "1", [] as never],
      ["null data", "1", null as never],
    ])("refuses %s before sending", async (_label, id, data) => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.sendTemplate(THREAD_ID, id, data)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("treats a template send without a message_id as unconfirmed", async () => {
      const { adapter } = build(vi.fn(async () => ok({ user_id: USER_ID })));
      await expect(adapter.sendTemplate(THREAD_ID, "1", {})).rejects.toBeInstanceOf(NetworkError);
    });

    it("lists templates from the business host, with the total across pages", async () => {
      const templates = [{ templateId: 900025, templateName: "T1", status: "ENABLE" }];
      const fetchImpl = vi.fn(
        async () =>
          ({
            status: 200,
            json: async () => ({
              error: 0,
              message: "Success",
              data: templates,
              metadata: { total: 300 },
            }),
          }) as unknown as Response,
      );
      const { adapter } = build(fetchImpl);

      await expect(
        adapter.listTemplates({ offset: 5, limit: 20, status: "PENDING_REVIEW" }),
      ).resolves.toEqual({ templates, total: 300 });
      const { url, init } = lastCall(fetchImpl);
      expect(url.origin).toBe("https://business.openapi.zalo.me");
      expect(url.pathname).toBe("/template/all");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        offset: "5",
        limit: "20",
        status: "2",
      });
      expect((init.headers as Record<string, string>).access_token).toBe("acc_1");
    });

    it("falls back to the page length when Zalo reports no total", async () => {
      const { adapter } = build(vi.fn(async () => ok([{ templateId: 1 }, { templateId: 2 }])));
      await expect(adapter.listTemplates()).resolves.toMatchObject({ total: 2 });
    });

    it("lists the first hundred of every status by default", async () => {
      const fetchImpl = vi.fn(async () => ok([]));
      const { adapter } = build(fetchImpl);
      await adapter.listTemplates();
      expect(Object.fromEntries(lastCall(fetchImpl).url.searchParams)).toEqual({
        offset: "0",
        limit: "100",
      });
    });

    it.each([
      [{ limit: 0 }],
      [{ limit: 101 }],
      [{ limit: Number.NaN }],
      [{ offset: -1 }],
      [{ status: "toString" as never }],
      [{ status: "ACTIVE" as never }],
    ])("refuses the listing options %o", async (options) => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.listTemplates(options)).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("honours a custom business host", async () => {
      const fetchImpl = vi.fn(async () => ok([]));
      const adapter = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "s",
        oaSecretKey: OA_SECRET,
        oaId: OA_ID,
        accessToken: "a",
        refreshToken: "r",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        businessApiBaseUrl: "https://proxy.example/",
        fetchImpl: fetchImpl as never,
      });
      await adapter.listTemplates();
      expect(lastCall(fetchImpl).url.href).toBe(
        "https://proxy.example/template/all?offset=0&limit=100",
      );
    });
  });

  describe("read receipts", () => {
    function seenEvent(overrides: Partial<ZaloOaWebhookEvent> = {}): ZaloOaWebhookEvent {
      return userEvent({
        event_name: "user_seen_message",
        sender: { id: OA_ID },
        recipient: { id: USER_ID },
        message: { msg_ids: ["43b59c025aeabfb5e6fa", "m2"] },
        timestamp: String(T0 + 5000),
        ...overrides,
      });
    }

    function withReceipt(onReadReceipt: ReturnType<typeof vi.fn>) {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const adapter = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "s",
        oaSecretKey: OA_SECRET,
        oaId: OA_ID,
        accessToken: "a",
        refreshToken: "r",
        logger: logger as never,
        onReadReceipt,
      });
      return { adapter, logger };
    }

    it("delivers who read which messages and when", async () => {
      const onReadReceipt = vi.fn();
      const { adapter } = withReceipt(onReadReceipt);
      const event = seenEvent({ timestamp: String(Date.now() - 1000) });
      const response = await adapter.handleWebhook(webhookRequest(event));

      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(onReadReceipt).toHaveBeenCalledTimes(1));
      expect(onReadReceipt).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        userId: USER_ID,
        messageIds: ["43b59c025aeabfb5e6fa", "m2"],
        readAt: new Date(Number(event.timestamp)),
        raw: event,
      });
    });

    it("checks ownership against the sender, since the OA sent what was read", async () => {
      const onReadReceipt = vi.fn();
      const { adapter, logger } = withReceipt(onReadReceipt);
      await adapter.handleWebhook(
        webhookRequest(seenEvent({ sender: { id: "999" }, timestamp: String(Date.now()) })),
      );
      expect(onReadReceipt).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA webhook for a different Official Account",
        { event: "user_seen_message" },
      );
    });

    it.each([
      ["no message IDs", { message: { msg_ids: [] } }],
      ["no user", { recipient: { id: "" } }],
    ])("ignores a receipt with %s", async (_label, overrides) => {
      const onReadReceipt = vi.fn();
      const { adapter, logger } = withReceipt(onReadReceipt);
      const event = seenEvent({ timestamp: String(Date.now()), ...overrides });
      await adapter.handleWebhook(webhookRequest(event));
      expect(onReadReceipt).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA read receipt with no user, messages or time",
        expect.anything(),
      );
    });

    it("refuses to date a receipt from an implausible timestamp rather than from now", async () => {
      // A receipt is a high-water mark: dating one "now" would mark messages
      // sent after it as read. The stamp has to pass the signature's age
      // check yet fail the plausibility floor, which only a clock set before
      // 2010 allows.
      vi.useFakeTimers({ now: 946_684_800_000 });
      try {
        const onReadReceipt = vi.fn();
        const { adapter, logger } = withReceipt(onReadReceipt);
        await adapter.handleWebhook(webhookRequest(seenEvent({ timestamp: "946684800000" })));
        expect(onReadReceipt).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "Ignoring a Zalo OA read receipt with no user, messages or time",
          expect.objectContaining({ timestamp: "946684800000" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("delivers a redelivered receipt once", async () => {
      const onReadReceipt = vi.fn();
      const { adapter } = withReceipt(onReadReceipt);
      const event = seenEvent({ timestamp: String(Date.now() - 1000) });
      await adapter.handleWebhook(webhookRequest(event));
      await adapter.handleWebhook(webhookRequest(event));
      await vi.waitFor(() => expect(onReadReceipt).toHaveBeenCalledTimes(1));
    });

    it("registers the handler with waitUntil so a serverless runtime keeps it alive", async () => {
      let release: () => void = () => {};
      const onReadReceipt = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
      const { adapter } = withReceipt(onReadReceipt);
      const waitUntil = vi.fn();

      const response = await adapter.handleWebhook(
        webhookRequest(seenEvent({ timestamp: String(Date.now()) })),
        { waitUntil },
      );

      expect(response.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      const [task] = waitUntil.mock.calls[0] as [Promise<unknown>];
      let settled = false;
      void task.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await expect(task).resolves.toBeUndefined();
    });

    it("logs a failing handler and still answers 200", async () => {
      const onReadReceipt = vi.fn(async () => {
        throw new Error("db down");
      });
      const { adapter, logger } = withReceipt(onReadReceipt);
      const response = await adapter.handleWebhook(
        webhookRequest(seenEvent({ timestamp: String(Date.now()) })),
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith("The onReadReceipt handler failed", {
          error: expect.any(Error),
          userId: USER_ID,
        }),
      );
    });

    it("notes a receipt nobody listens for at debug", async () => {
      const { adapter, logger } = await initialized();
      await adapter.handleWebhook(webhookRequest(seenEvent({ timestamp: String(Date.now()) })));
      expect(logger.debug).toHaveBeenCalledWith(
        "A Zalo OA read receipt arrived but no onReadReceipt is configured",
        { userId: USER_ID },
      );
    });
  });

  describe("anonymous users", () => {
    const ANON_ID = "1ffedc467f179649cf06";
    const CONV_ID = "fa8f3f8701c2e89cb1d3";
    const ANON_THREAD = `zalo-oa:${OA_ID}:anonymous:${ANON_ID}:${CONV_ID}`;

    function anonEvent(overrides: Partial<ZaloOaWebhookEvent> = {}): ZaloOaWebhookEvent {
      return userEvent({
        event_name: "anonymous_send_text",
        sender: { id: ANON_ID },
        recipient: { id: OA_ID },
        message: { conversation_id: CONV_ID, text: "hello", msg_id: "76eef2edcba822f67bb9" },
        ...overrides,
      });
    }

    it("files an anonymous message under a thread carrying both IDs", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(webhookRequest(anonEvent()));

      expect(processed[0]?.threadId).toBe(ANON_THREAD);
      expect(processed[0]?.message.author.userId).toBe(ANON_ID);
      expect(processed[0]?.message.text).toBe("hello");
      expect(adapter.isDM(ANON_THREAD)).toBe(true);
      expect(processed[0]?.message.isMention).toBeUndefined();
    });

    it("refuses an anonymous message without a conversation", async () => {
      const { adapter, processed, logger } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(anonEvent({ message: { msg_id: "x", text: "y" } })),
      );
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring a Zalo OA message with no ID, sender or conversation",
        expect.objectContaining({ event: "anonymous_send_text" }),
      );
    });

    it("ignores the OA's anonymous echoes", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          anonEvent({
            event_name: "oa_send_anonymous_text",
            sender: { id: OA_ID },
            recipient: { id: ANON_ID },
          }),
        ),
      );
      expect(processed).toHaveLength(0);
    });

    it("exposes an anonymous user's image and sticker as attachments", async () => {
      const { adapter, processed } = await initialized();
      await adapter.handleWebhook(
        webhookRequest(
          anonEvent({
            event_name: "anonymous_send_sticker",
            message: {
              conversation_id: CONV_ID,
              msg_id: "s",
              attachments: [{ type: "sticker", payload: { id: "0", url: "https://x/s" } }],
            },
          }),
        ),
      );
      expect(processed[0]?.message.attachments[0]).toMatchObject({
        type: "image",
        url: "https://x/s",
      });
      expect(getStickerId(processed[0]?.message.raw)).toBe("0");
    });

    it("sends text to the anonymous endpoint with both IDs", async () => {
      const fetchImpl = vi.fn(async () =>
        ok({ message_id: "am1", anonymous_id: ANON_ID, conversation_id: CONV_ID }),
      );
      const { adapter } = build(fetchImpl);
      const result = await adapter.postMessage(ANON_THREAD, "hi");

      expect(result).toMatchObject({ id: "am1", threadId: ANON_THREAD });
      const { url, body } = lastCall(fetchImpl);
      expect(url.href).toBe("https://openapi.zalo.me/v2.0/oa/message");
      expect(body).toEqual({
        recipient: { anonymous_id: ANON_ID, conversation_id: CONV_ID },
        message: { text: "hi" },
      });
    });

    it("sends a file and a sticker to an anonymous user", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        url.includes("/upload/")
          ? ok({ token: "tok" })
          : ok({ message_id: "am", anonymous_id: ANON_ID, conversation_id: CONV_ID }),
      );
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(ANON_THREAD, {
        raw: "",
        files: [{ data: PDF, filename: "a.pdf" }],
      });
      expect(lastCall(fetchImpl).body).toEqual({
        recipient: { anonymous_id: ANON_ID, conversation_id: CONV_ID },
        message: { attachment: { type: "file", payload: { token: "tok" } } },
      });
      await adapter.sendSticker(ANON_THREAD, "st");
      expect(lastCall(fetchImpl).body.recipient).toEqual({
        anonymous_id: ANON_ID,
        conversation_id: CONV_ID,
      });
    });

    it("sends an image by URL to an anonymous user", async () => {
      const fetchImpl = vi.fn(async () =>
        ok({ message_id: "am", anonymous_id: ANON_ID, conversation_id: CONV_ID }),
      );
      const { adapter } = build(fetchImpl);
      await adapter.sendImageUrl(ANON_THREAD, "https://cdn.example/a.jpg");
      expect(lastCall(fetchImpl).body).toEqual({
        recipient: { anonymous_id: ANON_ID, conversation_id: CONV_ID },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "media",
              elements: [{ media_type: "image", url: "https://cdn.example/a.jpg" }],
            },
          },
        },
      });
    });

    it("refuses an image for an anonymous user before uploading, since Zalo takes only a URL", async () => {
      const fetchImpl = vi.fn();
      const { adapter } = build(fetchImpl);
      await expect(
        adapter.postMessage(ANON_THREAD, { raw: "", files: [{ data: PNG, filename: "a.png" }] }),
      ).rejects.toThrow(/only by URL/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
      ["history", (a: ZaloOaAdapter) => a.fetchMessages(ANON_THREAD)],
      ["a quoted reply", (a: ZaloOaAdapter) => a.reply(ANON_THREAD, "m", "x")],
      ["a reaction", (a: ZaloOaAdapter) => a.addReaction(ANON_THREAD, "m", "heart")],
      ["a template", (a: ZaloOaAdapter) => a.sendTemplate(ANON_THREAD, "1", {})],
    ])("refuses %s, which Zalo does not offer for anonymous users", async (_label, call) => {
      const { adapter, fetchImpl } = build();
      await expect(call(adapter)).rejects.toBeInstanceOf(NotImplementedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("parses an anonymous send result under its thread", () => {
      const { adapter } = build();
      expect(
        adapter.parseMessage({ message_id: "s", anonymous_id: ANON_ID, conversation_id: CONV_ID })
          .threadId,
      ).toBe(ANON_THREAD);
    });

    it("describes an anonymous thread as a DM", async () => {
      const { adapter } = build();
      await expect(adapter.fetchThread(ANON_THREAD)).resolves.toMatchObject({ isDM: true });
    });
  });

  describe("images by URL", () => {
    it("sends with a caption one to one, and an empty caption to a group", async () => {
      const fetchImpl = vi.fn(async () => ok({ message_id: "m", user_id: USER_ID }));
      const { adapter } = build(fetchImpl);

      await adapter.sendImageUrl(THREAD_ID, "https://x/a.png", "Look");
      expect(lastCall(fetchImpl).url.pathname).toBe("/v3.0/oa/message/cs");
      expect(lastCall(fetchImpl).body.message).toEqual({
        text: "Look",
        attachment: {
          type: "template",
          payload: {
            template_type: "media",
            elements: [{ media_type: "image", url: "https://x/a.png" }],
          },
        },
      });

      await adapter.sendImageUrl(THREAD_ID, "https://x/a.png");
      expect(lastCall(fetchImpl).body.message).not.toHaveProperty("text");

      await adapter.sendImageUrl(`zalo-oa:${OA_ID}:group:abc`, "https://x/a.png");
      expect(lastCall(fetchImpl).url.pathname).toBe("/v3.0/oa/group/message");
      expect(lastCall(fetchImpl).body.message.text).toBe("");
    });

    it.each(["ftp://x/a.png", "data:image/png;base64,AA==", "", "x/a.png"])(
      "refuses the URL %j",
      async (url) => {
        const { adapter, fetchImpl } = build();
        await expect(adapter.sendImageUrl(THREAD_ID, url)).rejects.toBeInstanceOf(ValidationError);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it("refuses an over-long caption", async () => {
      const { adapter, fetchImpl } = build();
      await expect(
        adapter.sendImageUrl(THREAD_ID, "https://x/a.png", "a".repeat(2001)),
      ).rejects.toThrow(/caption is 2001/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("templates by phone", () => {
    const receipt = {
      msg_id: "a4d0243feee163bd3af2",
      sent_time: String(T0),
      sending_mode: "1",
      quota: { dailyQuota: "500", remainingQuota: "499" },
    };

    it("sends to the business host with a generated tracking ID", async () => {
      const fetchImpl = vi.fn(async () => ok(receipt));
      const { adapter } = build(fetchImpl);
      const result = await adapter.sendTemplateByPhone("+84 987 654 321", 7895417, { ky: "1" });

      const { url, body } = lastCall(fetchImpl);
      expect(url.href).toBe("https://business.openapi.zalo.me/message/template");
      expect(body).toMatchObject({
        phone: "84987654321",
        template_id: "7895417",
        template_data: { ky: "1" },
      });
      expect(body.tracking_id).toMatch(/^[0-9a-f]{32}$/);
      expect(body).not.toHaveProperty("sending_mode");
      expect(result).toEqual({
        messageId: "a4d0243feee163bd3af2",
        trackingId: body.tracking_id,
        sentAt: new Date(T0),
        remainingDailyQuota: 499,
        raw: receipt,
      });
    });

    it("forwards a tracking ID and the over-quota mode", async () => {
      const fetchImpl = vi.fn(async () => ok({ msg_id: "m" }));
      const { adapter } = build(fetchImpl);
      const result = await adapter.sendTemplateByPhone(
        "84987654321",
        "t",
        {},
        {
          trackingId: "order-42",
          sendingMode: 3,
        },
      );
      expect(lastCall(fetchImpl).body).toMatchObject({
        tracking_id: "order-42",
        sending_mode: "3",
      });
      expect(result).toMatchObject({
        trackingId: "order-42",
        sentAt: undefined,
        remainingDailyQuota: undefined,
      });
    });

    it("refuses a sending mode Zalo does not define before sending", async () => {
      const { adapter, fetchImpl } = build();
      await expect(
        adapter.sendTemplateByPhone("84987654321", "t", {}, { sendingMode: 2 as never }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
      ["a local number", "0987654321"],
      ["letters", "84abc"],
      ["an empty number", ""],
      ["a too-long number", "8498765432198765"],
    ])("refuses %s before sending", async (_label, phone) => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.sendTemplateByPhone(phone, "t", {})).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each(["", "a".repeat(49), "has space", "x/y"])(
      "refuses the tracking ID %j",
      async (trackingId) => {
        const { adapter, fetchImpl } = build();
        await expect(
          adapter.sendTemplateByPhone("84987654321", "t", {}, { trackingId }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it("refuses an empty template ID and non-object data", async () => {
      const { adapter, fetchImpl } = build();
      await expect(adapter.sendTemplateByPhone("84987654321", " ", {})).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        adapter.sendTemplateByPhone("84987654321", "t", [] as never),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("treats a receipt without msg_id as unconfirmed", async () => {
      const { adapter } = build(vi.fn(async () => ok({ sent_time: "1" })));
      await expect(adapter.sendTemplateByPhone("84987654321", "t", {})).rejects.toBeInstanceOf(
        NetworkError,
      );
    });
  });

  describe("app secret proof", () => {
    it("is not sent unless enabled", async () => {
      const fetchImpl = vi.fn(async () => ok({ message_id: "m", user_id: USER_ID }));
      const { adapter } = build(fetchImpl);
      await adapter.postMessage(THREAD_ID, "hi");
      expect(lastCall(fetchImpl).init.headers).not.toHaveProperty("appsecret_proof");
    });

    it("sends HMAC-SHA256(appSecret, accessToken) on a JSON send, an upload and the business host", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        url.includes("/upload/")
          ? ok({ attachment_id: "att" })
          : url.includes("/template/all")
            ? ok([])
            : ok({ message_id: "m", user_id: USER_ID }),
      );
      const adapter = new ZaloOaAdapter({
        appId: APP_ID,
        appSecret: "app_secret",
        oaSecretKey: OA_SECRET,
        oaId: OA_ID,
        accessToken: "acc_1",
        refreshToken: "ref_1",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        appSecretProof: true,
        fetchImpl: fetchImpl as never,
      });
      const expected = crypto.createHmac("sha256", "app_secret").update("acc_1").digest("hex");

      await adapter.postMessage(THREAD_ID, "hi");
      await adapter.postMessage(THREAD_ID, { raw: "", files: [{ data: PNG, filename: "a.png" }] });
      await adapter.listTemplates();

      for (const call of fetchImpl.mock.calls) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).appsecret_proof).toBe(expected);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });
  });

  describe("unsupported operations", () => {
    it.each([
      ["editMessage", (a: ZaloOaAdapter) => a.editMessage(THREAD_ID, "m", "x")],
      ["deleteMessage", (a: ZaloOaAdapter) => a.deleteMessage(THREAD_ID, "m")],
    ])("%s throws NotImplementedError", async (_name, call) => {
      const { adapter } = build();
      await expect(call(adapter)).rejects.toBeInstanceOf(NotImplementedError);
    });
  });
});
