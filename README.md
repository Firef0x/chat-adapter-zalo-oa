# chat-adapter-zalo-oa

[Chat SDK](https://chat-sdk.dev) adapter for the [Zalo Official Account (OA) API](https://docs.zaloplatforms.com/docs/OA).

It covers **one-to-one conversations** and **GMF group chats**: text, images, GIFs, files and stickers in both directions, reactions and quoted replies one to one, history, and **ZBS template messages**.

> This targets the Official Account API at `openapi.zalo.me`. It is a different product from the Zalo Bot Platform, which [`chat-adapter-zalo`](https://www.npmjs.com/package/chat-adapter-zalo) covers.

## Install

```bash
npm install chat-adapter-zalo-oa chat
```

## Usage

```ts
import { Chat } from "chat";
import { createZaloOaAdapter } from "chat-adapter-zalo-oa";

const zaloOa = createZaloOaAdapter({
  onTokenRefresh: async (tokens) => {
    // Required in practice: the refresh token is single-use.
    await saveZaloTokens(tokens);
  },
});

const bot = new Chat({
  userName: "acme",
  adapters: { zaloOa },
  state,
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

// Next.js route handler
export async function POST(request: Request) {
  return bot.webhooks.zaloOa(request, { waitUntil: after });
}
```

## Setup

1. **Create an app** on [developers.zalo.me](https://developers.zalo.me) and note its **App ID** and **secret key**.
2. **Link the app to your OA** and grant it at least *send messages and notifications via OA* and *manage user messages*. Grant *manage OA information* for `fetchChannelInfo()`, *manage user information* for `getUser()`, *manage group information* for group chats, and *manage message templates* for `listTemplates()`.
3. **Get tokens.** For a single OA, the API Explorer under *Tools* issues an OA access token and refresh token directly. For third-party apps, use the OAuth v4 PKCE flow described in Zalo's [authorization guide](https://docs.zaloplatforms.com/docs/OA/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new).
4. **Configure the webhook** in the app's settings: set the URL, copy the **OA secret key** shown there, and enable the `user_send_*` events, `user_reacted_message`, and the `user_send_group_*` events if you use groups.

Zalo requires a paid OA service package (Growth or Complete) to link an app through the API.

## Configuration

| Option | Env var | Description |
| --- | --- | --- |
| `appId` | `ZALO_OA_APP_ID` | The Zalo app ID. |
| `appSecret` | `ZALO_OA_APP_SECRET` | The app's secret key. Used only to refresh tokens. |
| `oaSecretKey` | `ZALO_OA_SECRET_KEY` | The OA secret key from the webhook settings. Zalo signs webhooks with this, not with the app secret. |
| `oaId` | `ZALO_OA_ID` | The Official Account ID. |
| `accessToken` | `ZALO_OA_ACCESS_TOKEN` | Current OA access token. |
| `refreshToken` | `ZALO_OA_REFRESH_TOKEN` | Current refresh token. |
| `accessTokenExpiresAt` | | Epoch ms. If omitted, the adapter refreshes once on first use. |
| `refreshTokenExpiresAt` | | Epoch ms. |
| `onTokenRefresh` | | Called with the new tokens after every refresh. **Persist them.** |
| `signatureToleranceSeconds` | | Maximum webhook age. Default `7200`. |
| `userName` | | Bot display name. Default `"zalo-oa-bot"`. |
| `maxDownloadBytes` | | Largest attachment `fetchData()` will buffer. Default 50 MiB. Zalo users can send files of up to 1 GB. |
| `apiBaseUrl`, `oauthBaseUrl`, `businessApiBaseUrl` | | Override the API hosts, for a proxy. |
| `maxRateLimitRetries`, `rateLimitRetryDelayMs` | | Throttling backoff. Defaults `2` and `1000`. |

### Tokens

Access tokens last 25 hours and refresh tokens three months. A refresh token works **once**: every refresh invalidates it and the old access token, and returns a new pair. The adapter refreshes automatically, shares one refresh between concurrent requests, and hands the new pair to `onTokenRefresh`. A host that does not persist them loses the connection on its next restart. A failure inside `onTokenRefresh` is logged at error level and does not fail the request, since the rotation has already happened at Zalo.

## Webhooks

Every webhook is verified before anything acts on it. The `X-ZEvent-Signature` header carries `mac=<hex>`, and the hex is `sha256(appId + rawBody + timestamp + oaSecretKey)`. The timestamp comes from the body.

| Delivery | Response |
| --- | --- |
| Bad or missing signature | `401` |
| Body is not JSON | `400` |
| Genuine but older than `signatureToleranceSeconds` | `200`, dropped with a warning |
| Anything else | `200` |

Errors while handling a genuine delivery are logged and still answered `200`. Zalo redelivers only when it cannot connect at all, so an error status would buy no retry, and Zalo disables webhooks that keep failing.

Zalo also expects an answer **within two seconds**, so the adapter does not wait for your handler. Pass `waitUntil` on serverless runtimes so the handler keeps running after the response is sent. Chat SDK logs a handler that throws.

The default tolerance of two hours is deliberate. Zalo retries a failed delivery after 30 s, 5 min, 15 min, 30 min and 1 h, each time with the original timestamp. A shorter window would discard exactly the retries meant to recover an outage. Redeliveries are deduplicated by message ID.

The adapter dispatches `user_send_*` and `user_send_group_*` events as messages and `user_reacted_message` as reactions. It ignores the OA's own `oa_send_*`, `oa_send_group_*` and `oa_reacted_message` echoes, so the bot never answers itself or a colleague using the OA chat tool. Other event types are ignored.

Each event is checked against the configured OA before it is handled. A one-to-one event names the OA as its recipient. A group event's recipient is the group, so the check reads its `oa_id` instead, and a group event without one is refused.

## Messaging rules

Zalo enforces these, not the adapter:

- An OA can send consultation messages only to a user who **interacted within the last 7 days**. Otherwise the send fails with a `ValidationError`, and a paid [template message](#template-messages) is the way to reach them.
- Consultation messages are free within **48 hours** of the user's last interaction and charged after that.
- Text is limited to **2,000 characters**. Longer messages are refused before a request is made.

## Group chats

Zalo's group chats (GMF) are groups the OA owns, created through the OA and paid for by its service package. A group thread ID has the form `zalo-oa:<oaId>:group:<groupId>`, and `isDM()` is `false` for it.

- **Receiving:** members' messages arrive like one-to-one messages, attachments included. A message whose text contains `[@<oaId>]` mentions the OA and is delivered with `isMention: true`, so `onNewMention` fires for it. `[@<groupId>]`, which addresses every member, does not count as a mention of the bot.
- **Sending:** text, images, GIFs, files and stickers work as they do one to one. Mention a member by writing `[@<userId>]` in the text, or everyone with `[@<groupId>]`. Zalo has no messaging window for groups.
- **Not offered by Zalo in groups:** quoted replies, reactions and template messages. These throw `NotImplementedError` for a group thread.
- **History:** read five at a time, the page size Zalo documents for groups.

Creating groups and managing members are not covered by this adapter.

## Template messages

ZBS templates are how an OA reaches a user outside the seven-day consultation window. You register a template with Zalo, which reviews it and fixes its layout. A send only names the template and fills in its parameters:

```ts
await zaloOa.sendTemplate(threadId, "433555", {
  customer: "Nguyễn Thị Hoàng Anh",
  total: 100000,
});

const templates = await zaloOa.listTemplates({ status: "ENABLE" });
```

- Templates are sent by user ID, so only to one-to-one threads.
- Every successful send is **charged**. There is no free allowance.
- Templates created before 10 December 2025, OTP templates and a few other kinds can be sent by phone number only. Sending one by user ID fails with a `ValidationError` for error `-249`.
- `listTemplates()` returns at most 100 per call, newest first, and can filter by `ENABLE`, `PENDING_REVIEW`, `REJECT` or `DISABLE`.

## Sending media

A message can carry **one** attachment through Chat SDK's `files`:

```ts
await thread.post({
  markdown: "New arrivals",
  files: [{ data: imageBuffer, filename: "arrivals.png" }],
});
```

| Kind | Formats | Max size | Text |
| --- | --- | --- | --- |
| Image | JPG, PNG | 1 MB | Sent as the caption |
| GIF | GIF | 5 MB | Sent as the caption |
| File | PDF, DOC, DOCX, CSV | 5 MB | Not allowed |

Images and GIFs are recognized by their bytes, not their name, so a WebP named `photo.png` is refused locally instead of by Zalo. A GIF's width and height, which Zalo requires, are read from its header. Every limit is checked before uploading, because uploads spend from a quota of 5,000 a month. Zalo writes "1MB" and "5MB" without saying which megabyte, so the limits use the stricter decimal reading.

Several attachments, or text together with a file, are refused rather than split into several messages. Send them separately so you decide the order and get back every message ID. Quoted replies carry text only. Zalo keeps uploaded media for seven days.

## Stickers

Chat SDK has no sticker concept, so stickers have their own method on the adapter:

```ts
import { getStickerId } from "chat-adapter-zalo-oa";

bot.onDirectMessage(async (thread, message) => {
  const stickerId = getStickerId(message.raw);
  if (stickerId) {
    await zaloOa.sendSticker(thread.id, stickerId);
  }
});
```

Zalo has no API that lists stickers. IDs come from [stickers.zaloapp.com](https://stickers.zaloapp.com) or from a sticker a user sent. An inbound sticker also arrives as an image attachment.

## Reactions

Zalo offers a fixed set of reactions:

| Chat SDK emoji | Zalo code |
| --- | --- |
| `thumbs_up` 👍 | `/-strong` |
| `heart` ❤️ | `/-heart` |
| `laugh` 😆 | `:>` |
| `surprised` 😮 | `:o` |
| `cry` 😭 | `:-((` |
| `angry` 😠 | `:-h` |
| none | `--b` |

`addReaction` accepts an emoji value, its name, its Unicode form, or the Zalo code. `--b` has no documented meaning, so it is sent and received only by its code. Any other emoji is refused with the list above.

Zalo's withdrawal names no emoji. `removeReaction` therefore removes whatever reaction the OA placed on the message, not only the one you pass. When a user withdraws a reaction, the event arrives with `added: false` and `rawEmoji: "/-remove"`, so you learn that they withdrew one, not which.

## Features

| Feature | Support |
| --- | --- |
| Receive text, image, GIF, sticker, video, audio, file | Yes. Media arrives as attachments with `fetchData()`. |
| Receive link and location | As text |
| Send text | Yes |
| Send image, GIF, file | Yes, one per message |
| Send and receive stickers | `sendSticker()`, `getStickerId()` |
| Send and receive reactions | Yes, Zalo's fixed set, one to one |
| Group chats | Send and receive, history, mentions |
| Template messages | `sendTemplate()`, `listTemplates()` |
| Reply with a quote | Yes, via `reply()` |
| Cards | Flattened to text, buttons listed as options |
| Message history | Yes. Backward only, 10 per request, offset cursor. |
| Open a DM | `openDM(userId)`, subject to the 7-day rule |
| OA profile, user profile | `fetchChannelInfo()`, `getUser()` |
| Typing indicator | No-op. Zalo has no such API. |
| Edit, delete | Not supported by Zalo |
| Creating groups, managing members, templates by phone number | Not covered |

## Errors

Zalo reports failures as HTTP 200 with a non-zero `error`. The adapter maps them to Chat SDK's error types:

| Error | Codes |
| --- | --- |
| `AdapterRateLimitError` | `-32`, retried with backoff first |
| `AuthenticationError` | `-216`, `-220`, after one automatic refresh |
| `PermissionError` | App, OA or group misconfigured: `-204`, `-205`, `-209`, `-212`, `-219`, `-221`, `-223`, `-224`, `-235`, `-237`, `-242`, `-320`, `-321` |
| `ValidationError` | Request or recipient refused: `-100`, `-201`, `-210`, `-211`, `-213`, `-218`, `-227`, `-230`, `-232`, `-233`, `-234`, `-244`, `-248`, `-249`, `-403` |
| `NetworkError` | Transport failures, `-200`, and unknown codes. These are worth retrying. |

## Development

```bash
npm install
npm run verify   # lint, typecheck, test, build
```

## License

Apache-2.0
