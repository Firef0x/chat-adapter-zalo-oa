# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-15

First release.

### Added

- One-to-one conversations: receive text, images, GIFs, stickers, video, audio,
  files, links and locations; send text, images, GIFs, files and stickers;
  quoted replies; history paged backward from the newest message.
- GMF group chats: receive members' messages, send text and media, read
  history, and detect mentions of the OA written as `[@oaId]`.
- Reactions in both directions, mapped between Zalo's fixed set and Chat SDK
  emoji.
- ZBS template messages by user ID, and listing the OA's templates.
- Webhook verification against the configured app ID, with a two-hour window
  sized to Zalo's retry schedule and deduplication of redeliveries.
- Automatic access-token refresh with single-flight rotation of the single-use
  refresh token, reported to the host through `onTokenRefresh`.
- Optional `appsecret_proof` header for apps that require it.
- Zalo error codes mapped onto Chat SDK's error types by retryability.

[Unreleased]: https://github.com/Firef0x/chat-adapter-zalo-oa/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Firef0x/chat-adapter-zalo-oa/releases/tag/v0.1.0
