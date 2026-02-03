# Message Bridge Plugin for OpenCode

[English](https://github.com/YuanG1944/message-bridge-opencode-plugin/blob/main/README.md) | [中文](https://github.com/YuanG1944/message-bridge-opencode-plugin/blob/main/README.zh.md)

---

## English

# Message Bridge Plugin for OpenCode

`message-bridge-opencode-plugin` is a **universal message bridge plugin** designed for **OpenCode Agent**.
It enables AI Agents to connect with **multiple messaging platforms** through a unified abstraction layer.

The project **initially focused on Feishu (Lark)** integration.
After validation and real-world usage, it has evolved into a **general-purpose message bridge**, allowing OpenCode Agents to interact with different IM platforms in a consistent way.

---

## ✨ Current Status

### ✅ Fully Supported

* **Feishu / Lark**

  * Production-ready
  * Supports **Webhook** and **WebSocket** modes
  * Stable message receiving & forwarding
  * Fully compatible with OpenCode plugin system

### 🚧 Under Active Development

* **iMessage** (Next priority)
* Other IM platforms (planned):

  * Telegram
  * Slack
  * Discord
  * WhatsApp (subject to API availability)

> The architecture is designed to make adding new platforms straightforward and incremental.

---

## ✨ Features

* **Universal Message Abstraction**

  * One OpenCode Agent, multiple messaging platforms
* **Plug & Play**

  * Fully compatible with OpenCode plugin system
* **Multiple Communication Modes**

  * `webhook` – Recommended for production
  * `ws` (WebSocket) – Ideal for local development (no public IP required)
* **Config-driven**

  * All credentials and behavior managed via `opencode.json`
* **Extensible Architecture**

  * New platforms can be added without changing core agent logic

---

## ✅ Slash Command Support

This plugin **implements key slash commands via OpenCode APIs**, and **falls back to `session.command`** for custom commands.
UI-only commands (theme/editor/exit, etc.) are **not supported in chat**.

### Built-in Slash Commands (TUI)

From the official TUI docs, the built-in commands include:

* `/connect`
* `/compact` (alias: `/summarize`)
* `/details`
* `/editor`
* `/exit` (aliases: `/quit`, `/q`)
* `/export`
* `/help`
* `/init`
* `/models`
* `/new` (alias: `/clear`)
* `/redo`
* `/sessions` (aliases: `/resume`, `/continue`)
* `/share`
* `/theme`
* `/thinking`
* `/undo`
* `/unshare`

### Bridge-Handled Commands

These are implemented directly against OpenCode APIs:

* `/help` → list custom commands
* `/models` → list providers and models
* `/new` → create and bind to a new session
* `/sessions` → list sessions (reply with `/sessions <id>` to bind)
* `/share` / `/unshare`
* `/compact` (alias `/summarize`)
* `/init`
* `/agent <name>` → bind agent for future prompts

### UI-Only Commands (Not Supported in Chat)

* `/connect`
* `/details`
* `/editor`
* `/export`
* `/exit` (`/quit`, `/q`)
* `/theme`
* `/thinking`

### Custom Commands

Custom commands are supported via:

* `opencode.json` under `command`, or
* `.opencode/commands/*.md` files.

### Session / Agent Switching

Session switching via `/sessions` is fully supported. The list is returned to the chat, and you can reply with `/sessions <id>` **or** `/sessions <index>` to bind this chat to the chosen session.

If your OpenCode setup provides additional slash commands, they will still be forwarded via `session.command` unless explicitly handled above.

---

## 📦 Installation

Inside your OpenCode Agent config directory:

```bash
npm install message-bridge-opencode-plugin
```

> ⚠️ Due to a known OpenCode issue, installing directly from npm may not work at the moment.
> See **Development Mode Usage** below.

---

## 🚀 Quick Start

### ⚙️ Configuration (`opencode.json`)

> **Important:**
> It is strongly recommended to use **string values** for all config fields to avoid parsing issues.

### Feishu / Lark (Webhook mode)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"],
  "agent": {
    "lark-bridge": {
      "disable": false,
      "description": "Message Bridge Plugin",
      "options": {
        "platform": "feishu",
        "mode": "webhook",
        "app_id": "cli_xxxxxxx",
        "app_secret": "xxxxxxxxxx",
        "callback_url": "127.0.0.1:3000"
      }
    }
  }
}
```

### Feishu / Lark (WebSocket mode)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"],
  "agent": {
    "lark-bridge": {
      "disable": false,
      "description": "Message Bridge Plugin",
      "options": {
        "platform": "feishu",
        "mode": "ws",
        "app_id": "cli_xxxxxxx",
        "app_secret": "xxxxxxxxxx"
      }
    }
  }
}
```

---

## 🚧 Development Mode Usage (Required for now)

Due to an existing OpenCode issue:

> **Issue:** `fn3 is not a function`
> [https://github.com/anomalyco/opencode/issues/7792](https://github.com/anomalyco/opencode/issues/7792)

The plugin must currently be used in **local development mode**.

### 1️⃣ Clone the repository

```bash
git clone https://github.com/YuanG1944/message-bridge-opencode-plugin.git
```

### 2️⃣ Enter the directory

```bash
cd message-bridge-opencode-plugin
```

### 3️⃣ Install dependencies

```bash
bun install
```

> `bun` is recommended, as OpenCode’s build system is based on it.

### 4️⃣ Get the absolute path

```bash
pwd
# /your/path/message-bridge-opencode-plugin
```

### 5️⃣ Reference it in `opencode.json`

```json
{
  "plugin": ["/your/path/message-bridge-opencode-plugin"],
  "agent": {
    "message-bridge": {
      "options": {
        "platform": "feishu",
        "mode": "webhook"
      }
    }
  }
}
```

---

## 🛣 Roadmap

* [x] Feishu / Lark (Production ready)
* [ ] iMessage (Next milestone)
* [ ] Telegram
* [ ] Slack
* [ ] Discord
* [ ] Unified message reply & threading abstraction

---

## 🤝 Contributing

Contributions are welcome!

* New platform adapters
* Bug fixes
* Documentation improvements
* Design discussions

Feel free to open an Issue or Pull Request.

---

## 📄 License

MIT License
