# chat-adapter-zalo-oa

[Chat SDK](https://chat-sdk.dev) adapter for the [Zalo Official Account (OA) API](https://docs.zaloplatforms.com/docs/OA).

It covers **one-to-one conversations**, **anonymous chat-widget users** and **GMF group chats**: text, images, GIFs, files and stickers in both directions, reactions, quoted replies and read receipts one to one, history, **group management**, and **ZBS template messages** by user ID or phone number.

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
4. **Configure the webhook** in the app's settings: set the URL, copy the **OA secret key** shown there, and enable the `user_send_*` events, `user_reacted_message`, `user_seen_message` for read receipts, `anonymous_send_*` for chat-widget users, and the `user_send_group_*` events if you use groups.

Zalo requires a paid OA service package (Growth or Complete) to link an app through the API.

If the app has **app secret proof** checking enabled in its settings, set `appSecretProof: true`. The adapter then sends `HMAC-SHA256(appSecret, accessToken)` as the `appsecret_proof` header on every call, the way Zalo's own SDK does.

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
| `onReadReceipt` | | Called when a user reads messages the OA sent. See [Read receipts](#read-receipts). |
| `signatureToleranceSeconds` | | Maximum webhook age. Default `7200`. |
| `appSecretProof` | | Send an `appsecret_proof` header on every API call. Turn on if the app has that check enabled on developers.zalo.me, where calls without it fail with error `-242`. Default off. |
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

The adapter dispatches `user_send_*`, `anonymous_send_*` and `user_send_group_*` events as messages, `user_reacted_message` as reactions, and `user_seen_message` to `onReadReceipt`. It ignores the OA's own `oa_send_*`, `oa_send_anonymous_*`, `oa_send_group_*` and `oa_reacted_message` echoes, so the bot never answers itself or a colleague using the OA chat tool. Other event types are ignored.

Each event is checked against the configured OA before it is handled. A one-to-one event names the OA as its recipient. A group event's recipient is the group, so the check reads its `oa_id` instead, and a group event without one is refused.

## Messaging rules

Zalo enforces these, not the adapter:

- An OA can send consultation messages only to a user who **interacted within the last 7 days**. Otherwise the send fails with a `ValidationError`, and a paid [template message](#template-messages) is the way to reach them.
- Consultation messages are free within **48 hours** of the user's last interaction and charged after that.
- Text is limited to **2,000 characters**. Longer messages are refused before a request is made.

## Read receipts

Zalo reports when a user reads messages the OA sent, through `user_seen_message`. Chat SDK has no inbound read-receipt event, so it goes to a callback:

```ts
createZaloOaAdapter({
  onReadReceipt: async ({ threadId, messageIds, readAt }) => {
    await markRead(threadId, messageIds, readAt);
  },
});
```

Zalo emits it only when the user reads on Zalo Mobile, and only to the app that sent the message. A receipt is a high-water mark, so apply it as `max(existing, readAt)`: a redelivery can land after a newer one. A handler that throws is logged; Zalo does not redeliver on request. Pass `waitUntil` to the webhook on serverless runtimes so the handler outlives the response.

## Anonymous users

A person who writes through the OA's chat widget without signing in is **anonymous**: Zalo identifies them by an anonymous ID that is valid only within one conversation. The thread ID carries both, `zalo-oa:<oaId>:anonymous:<anonymousId>:<conversationId>`, so a reply needs nothing else. `isDM()` is `true` for it.

- **Receiving:** text, images, stickers and files arrive like one-to-one messages.
- **Sending:** text, files and stickers work as usual. Zalo takes an image for an anonymous user **only by URL**, never from uploaded bytes, so use `sendImageUrl()`; a `files` attachment that is an image is refused before anything is uploaded.
- **Not offered by Zalo:** history, quoted replies, reactions and templates. These throw `NotImplementedError`.

## Images by URL

```ts
await zaloOa.sendImageUrl(threadId, "https://cdn.example/arrivals.jpg", "New arrivals");
```

Works for every kind of thread, and is the only way to send an image to an anonymous user. Zalo fetches the URL itself and wants a public JPG or PNG of at most 1 MB.

## Group chats

Zalo's group chats (GMF) are groups the OA owns, created through the OA and paid for by its service package. A group thread ID has the form `zalo-oa:<oaId>:group:<groupId>`, and `isDM()` is `false` for it.

- **Receiving:** members' messages arrive like one-to-one messages, attachments included. An inbound document carries the MIME type of its extension. A message whose text contains `[@<oaId>]` mentions the OA and is delivered with `isMention: true`, so `onNewMention` fires for it. `[@<groupId>]`, which addresses every member, does not count as a mention of the bot.
- **Sending:** text, images, GIFs, files and stickers work as they do one to one. Mention a member by writing `[@<userId>]` in the text, or everyone with `[@<groupId>]`. Zalo has no messaging window for groups.
- **Not offered by Zalo in groups:** quoted replies, reactions and template messages. These throw `NotImplementedError` for a group thread.
- **History:** read five at a time, the page size Zalo documents for groups.

### Managing groups

`adapter.groups` wraps Zalo's group management API. A group runs on a GMF package the OA holds, called an asset; creating a group needs an available one, and a group whose package expires is dissolved after 45 days unless renewed.

```ts
const assets = await zaloOa.groups.listAssets();
const asset = assets.find((a) => a.status === "available");

const { threadId } = await zaloOa.groups.create({
  name: "Support",
  assetId: asset.asset_id,
  memberUserIds: [adminUserId, customerUserId], // 1–99, at least one OA admin
});

await zaloOa.groups.invite(threadId, [anotherUserId]);
const { items: members, total } = await zaloOa.groups.listMembers(threadId);
await zaloOa.groups.update(threadId, { name: "Support team", join_appr: true });
```

| Method | Zalo endpoint |
| --- | --- |
| `listAssets()` | Packages the OA holds, used or available |
| `create()`, `list()`, `get()`, `update()`, `renew()`, `delete()` | The group itself |
| `listMembers()`, `listPendingMembers()` | Members, five per page by default |
| `invite()`, `remove()`, `accept()`, `reject()` | Membership |
| `addAdmins()`, `removeAdmins()` | Deputy admins |

Every method takes and returns thread IDs. Invited users must follow the OA or have interacted with it in the last 7 days.

## Template messages

ZBS templates are how an OA reaches a user outside the seven-day consultation window. You register a template with Zalo, which reviews it and fixes its layout. A send only names the template and fills in its parameters:

```ts
await zaloOa.sendTemplate(threadId, "433555", {
  customer: "Nguyễn Thị Hoàng Anh",
  total: 100000,
});

const templates = await zaloOa.listTemplates({ status: "ENABLE" });
```

- `sendTemplate()` sends by user ID, so only to one-to-one threads.
- Every successful send is **charged**. There is no free allowance.
- `listTemplates()` returns `{ templates, total }`, at most 100 per call, newest first, and can filter by `ENABLE`, `PENDING_REVIEW`, `REJECT` or `DISABLE`.

### By phone number

```ts
const receipt = await zaloOa.sendTemplateByPhone("84987654321", "433555", data, {
  trackingId: "order-42", // yours, for reconciliation; generated when omitted
});
```

This reaches a number that has never interacted with the OA, and is the **only** way to send OTP templates and templates created before 10 December 2025, which fail by user ID with error `-249`. The number must be linked to a Zalo account and written with its country code. It needs the *send messages by phone number* permission, is charged at the phone rate, and draws on a daily quota Zalo adjusts to the OA's sending quality; the receipt reports what remains. A phone send belongs to no thread, so it returns Zalo's receipt rather than a message.

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
| Send an image by URL | `sendImageUrl()` |
| Read receipts | `onReadReceipt` |
| Anonymous chat-widget users | Send and receive; no history, quotes or reactions |
| Send and receive reactions | Yes, Zalo's fixed set, one to one |
| Group chats | Send and receive, history, mentions |
| Template messages | `sendTemplate()`, `sendTemplateByPhone()`, `listTemplates()` |
| Group management | `adapter.groups` |
| Reply with a quote | Yes, via `reply()` |
| Cards | Flattened to text, buttons listed as options |
| Message history | Yes. Backward only, 10 per request, offset cursor. |
| Open a DM | `openDM(userId)`, subject to the 7-day rule |
| OA profile, user profile | `fetchChannelInfo()`, `getUser()` |
| Typing indicator | No-op. Zalo has no such API. |
| Edit, delete | Not supported by Zalo |

## Errors

Zalo reports failures as HTTP 200 with a non-zero `error`. The adapter maps them to Chat SDK's error types:

| Error | Codes |
| --- | --- |
| `AdapterRateLimitError` | `-32`, retried with backoff first |
| `AuthenticationError` | `-216`, `-220`, after one automatic refresh |
| `PermissionError` | App, OA or group misconfigured: `-204`, `-205`, `-209`, `-212`, `-219`, `-221`, `-223`, `-224`, `-235`, `-237`, `-242` (see `appSecretProof`), `-320`, `-321` |
| `ValidationError` | Request or recipient refused: `-100`, `-201`, `-210`, `-211`, `-213`, `-218`, `-227`, `-230`, `-232`, `-233`, `-234`, `-244`, `-248`, `-249`, `-403` |
| `NetworkError` | Transport failures, `-200`, and unknown codes. These are worth retrying. |

## Development

```bash
npm install
npm run verify   # lint, typecheck, test, build
```

## License

Apache-2.0
