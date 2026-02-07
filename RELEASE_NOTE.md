# Release Note (2026-02-07)

## Highlights

- Refactored handler flow into smaller modules:
  - `incoming.flow.ts`
  - `event.flow.ts`
  - `execution.flow.ts`
  - `message.delivery.ts`
  - `command.ts`
- Improved execution/tool-step message aggregation behavior to reduce message spam and keep final answer separated.
- Added stronger runtime/state typing in handler and bridge paths, reducing `any` usage and aligning with SDK event shapes.
- Improved slash-command support and routing consistency.
- Added Telegram bridge support (Bot API polling + webhook):
  - receive incoming text messages
  - send/edit bridge messages in chat
  - wired `telegram-bridge` config parsing and adapter registration
  - media input support (photo/document/video/audio/voice/animation/sticker)
  - slash command compatibility improvements (including Telegram command filtering)
  - typing + reaction UX alignment (show loading reaction and clear when response is finalized)
  - improved retry/edit behavior and lower Telegram edit retry delay for better delivery latency
  - stronger conflict diagnostics for polling mode (`getUpdates` single-consumer conflict)
  - fixed Telegram reaction cleanup timing in slash-command and non-streaming reply paths
  - reduced duplicate/no-op edit churn to lower Telegram-side perceived latency

## Slash Command Updates

- Added/updated bridge commands:
  - `/status`
  - `/reset` (alias: `/restart`) for runtime reset + new session
  - `/sessions delete 1,2,3` (batch delete)
  - `/sessions delete all` (delete all except current)
  - `/agent` (list)
  - `/agent <index|name>` (switch)
  - `/models <providerIndex.modelIndex>` (switch)
- Improved command help text and command feedback formatting.

## Session / Agent / Model State

- Session/agent/model state handling is now clearer in status output.
- Model display in status/footer was simplified to reduce noise.
- `/new` now keeps the last selected agent/model for the same chat binding.
- New session initialization now defaults to `plan` only when no previous agent selection exists.

## Feishu Rendering / UX

- Iterative improvements to execution panel rendering and status rendering.
- Reduced noisy debug logging while retaining key diagnostic logs.


## Documentation

- Updated `README.md` command section to include new/extended command behaviors and examples.
- Updated `README.md` / `README.zh.md` with Telegram config and support status.
- Added Telegram config guide:
  - `config-guide/telegram/GUIDE.md`
  - `config-guide/telegram/GUIDE.zh.md`
- Added troubleshooting notes for:
  - polling conflict (`terminated by other getUpdates request`)
  - network reachability errors (`Unable to connect`)
