# 🚀 Quick Start --- Telegram (Bot API)

## 1) Create Bot and Get Token

1. Open `@BotFather` in Telegram.
2. Run `/newbot`.
3. Copy the generated token (`123456:xxxxxx`).

Keep this token private.

---

## 2) OpenCode Configuration (`opencode.json`)

> Note: Use **string values** for all options to avoid parsing issues.

### Polling Mode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"],
  "agent": {
    "telegram-bridge": {
      "disable": false,
      "description": "Telegram Message Bridge",
      "options": {
        "platform": "telegram",
        "mode": "polling",
        "bot_token": "123456:your_bot_token",
        "polling_timeout_sec": "20",
        "polling_interval_ms": "250"
      }
    }
  }
}
```

### Webhook Mode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"],
  "agent": {
    "telegram-bridge": {
      "disable": false,
      "description": "Telegram Message Bridge",
      "options": {
        "platform": "telegram",
        "mode": "webhook",
        "bot_token": "123456:your_bot_token",
        "callback_url": "https://your.domain.com/telegram/webhook",
        "webhook_secret_token": "your_secret_token"
      }
    }
  }
}
```

---

## 3) Start OpenCode

```bash
opencode web
```

Then send a message to your bot.

---

## 4) Behavior Notes

- Polling mode: only one runtime can consume updates for one bot token.
- Webhook mode: ensure callback URL is publicly reachable and HTTPS.
- Bridge slash commands are supported (for example `/new`, `/models`, `/sessions`, `/status`).
- `/start` is treated as Telegram-side command and filtered from bridge business flow.

---

## 5) Troubleshooting

### `Conflict: terminated by other getUpdates request`

Cause: multiple runtimes are polling the same bot token.

Fix:

1. Stop all other plugin runtimes.
2. Keep only one polling process.
3. Or switch to webhook mode.

### `Unable to connect. Is the computer able to access the url?`

Cause: network cannot reach Telegram Bot API.

Fix:

1. Check proxy/firewall.
2. Verify DNS/network egress.
3. Retry after network is available.

### Slow Telegram delivery

Possible factors:

1. Telegram API round-trip and edit limits.
2. Polling interval/timeout configuration.
3. Render/edit retries under poor network conditions.

Tips:

1. Use webhook mode for better real-time behavior.
2. Keep polling interval reasonably low (for example `200~300` ms) if using polling.
