# Release Note (2026-02-07)

## 🚀 Major Addition: Telegram Support

- Added **Telegram bridge support** (Bot API):
  - polling mode
  - webhook mode
  - incoming message handling
  - message send/edit pipeline
  - slash-command bridge flow
  - media input support (photo/document/video/audio/voice/animation/sticker)

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
- Telegram follow-up improvements:
  - command compatibility improvements (including Telegram command filtering)
  - typing + reaction UX alignment (show loading reaction and clear when response is finalized)
  - improved retry/edit behavior and lower Telegram edit retry delay for better delivery latency
  - stronger conflict diagnostics for polling mode (`getUpdates` single-consumer conflict)
  - fixed reaction cleanup timing in slash-command and non-streaming reply paths
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
- Bugfix ([#2](https://github.com/YuanG1944/message-bridge-opencode-plugin/issues/2)):
  - fixed `/new` incorrectly clearing existing chat state
  - now `/new` inherits previous agent/model instead of resetting all state

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

---

# Release Note (2026-02-08)

## 🚀 File Bridge Enhancements

- Added local-file outbound bridge for Feishu + Telegram:
  - auto-detect local paths from assistant output
  - validate/read local files and send as real platform attachments
  - message-level dedupe to avoid duplicate re-send on edits

## New Commands

- `/sendfile <path>`
  - force-send a local file via bot without depending on LLM behavior.
- `/savefile`
  - enter upload-wait mode; the next uploaded file is saved directly to local disk and returns saved path.
  - this flow bypasses LLM completely.

## Config Additions

- Added optional bridge config under `agent.message-bridge.options`:
  - `auto_send_local_files` (default `false`)
  - `auto_send_local_files_max_mb` (default `20`)
  - `auto_send_local_files_allow_absolute` (default `false`)
  - `webhook_listen_port` (Telegram webhook local listen port; fallback to callback_url port, then `18080`)

## Feishu Reliability

- Replaced SDK-first upload path with direct upload calls for attachments.
- New direct upload helpers were added in `src/feishu/patch.ts` for image/file upload using tenant token.
- This avoids recurring SDK socket-close failures in file upload path.

## Cross-OS Path Support

- Enhanced local path detection for outbound files:
  - Unix absolute/relative paths
  - `file://` URLs
  - Windows drive paths (`C:\...`)
  - Windows UNC paths (`\\server\share\...`)
