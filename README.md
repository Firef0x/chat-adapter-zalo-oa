# chat-adapter-zalo-oa

[Chat SDK](https://chat-sdk.dev) adapter for the [Zalo Official Account (OA) API](https://docs.zaloplatforms.com/docs/OA).

This release covers **one-to-one conversations** between an Official Account and a user: receiving their messages, replying, quoting, and reading history. Group chats (GMF), sending media, reactions and template messages are planned.

> This targets the Official Account API at `openapi.zalo.me`. It is a different product from the Zalo Bot Platform, which [`chat-adapter-zalo`](https://www.npmjs.com/package/chat-adapter-zalo) covers.

## Install

```bash
npm install chat-adapter-zalo-oa chat
```

## Usage

```ts
import { Chat } from "chat";
import { createZaloOaAdapter } from "chat-adapter-zalo-oa";

const bot = new Chat({
  userName: "acme",
  adapters: {
    zaloOa: createZaloOaAdapter({
      onTokenRefresh: async (tokens) => {
        // Required in practice: the refresh token is single-use.
        await saveZaloTokens(tokens);
      },
    }),
  },
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
2. **Link the app to your OA** and grant it at least *send messages and notifications via OA* and *manage user messages*. Grant *manage OA information* for `fetchChannelInfo()` and *manage user information* for `getUser()`.
3. **Get tokens.** For a single OA, the API Explorer under *Tools* issues an OA access token and refresh token directly. For third-party apps, use the OAuth v4 PKCE flow described in Zalo's [authorization guide](https://docs.zaloplatforms.com/docs/OA/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new).
4. **Configure the webhook** in the app's settings: set the URL, copy the **OA secret key** shown there, and enable the `user_send_*` events.

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
| `apiBaseUrl`, `oauthBaseUrl` | | Override the API hosts, for a proxy. |
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

The adapter dispatches `user_send_*` events. It ignores the OA's own `oa_send_*` echoes, so the bot never answers itself or a colleague using the OA chat tool. Group events and other event types are ignored in this release.

## Messaging rules

Zalo enforces these, not the adapter:

- An OA can send consultation messages only to a user who **interacted within the last 7 days**. Otherwise the send fails with a `ValidationError`. Sending to a user who has never interacted is not possible.
- Consultation messages are free within **48 hours** of the user's last interaction and charged after that.
- Text is limited to **2,000 characters**. Longer messages are refused before a request is made.

## Features

| Feature | Support |
| --- | --- |
| Receive text, image, GIF, sticker, video, audio, file | Yes. Media arrives as attachments with `fetchData()`. |
| Receive link and location | As text |
| Send text | Yes |
| Reply with a quote | Yes, via `reply()` |
| Cards | Flattened to text, buttons listed as options |
| Message history | Yes. Backward only, 10 per request, offset cursor. |
| Open a DM | `openDM(userId)`, subject to the 7-day rule |
| OA profile, user profile | `fetchChannelInfo()`, `getUser()` |
| Typing indicator | No-op. Zalo has no such API. |
| Edit, delete | Not supported by Zalo |
| Send media, reactions, group chats, template messages | Not yet |

## Errors

Zalo reports failures as HTTP 200 with a non-zero `error`. The adapter maps them to Chat SDK's error types:

| Error | Codes |
| --- | --- |
| `AdapterRateLimitError` | `-32`, retried with backoff first |
| `AuthenticationError` | `-216`, `-220`, after one automatic refresh |
| `PermissionError` | App or OA misconfigured: `-204`, `-205`, `-209`, `-212`, `-219`, `-221`, `-223`, `-224`, `-235`, `-242`, `-320`, `-321` |
| `ValidationError` | Request or recipient refused: `-100`, `-201`, `-210`, `-211`, `-213`, `-218`, `-227`, `-230`, `-232`, `-233`, `-234`, `-244`, `-248` |
| `NetworkError` | Transport failures, `-200`, and unknown codes. These are worth retrying. |

## Development

```bash
npm install
npm run verify   # lint, typecheck, test, build
```

## License

Apache-2.0
