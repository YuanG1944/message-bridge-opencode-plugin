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
* **Telegram (Bot API / Polling + Webhook)**

  * Supports incoming text messages
  * Supports common media receive (photo/document/video/audio/voice/sticker/animation)
  * Supports streamed reply send/edit
  * Supports slash-command flow in bridge

### 🚧 Under Active Development

* **iMessage** (Next priority)
* Other IM platforms (planned):

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
* `/reset` (alias: `/restart`)
* `/redo`
* `/sessions` (aliases: `/resume`, `/continue`)
* `/share`
* `/theme`
* `/thinking`
* `/undo`
* `/unshare`
* `/status`
* `/maxFileSize`
* `/maxFileRetry`
* `/agent`

### Bridge-Handled Commands

These are implemented directly against OpenCode APIs:

* `/help` → list custom commands
* `/models` → list providers and models (`/models <providerIndex.modelIndex>` to switch)
* `/new` → create and bind to a new session
* `/rename <title>` → rename current session (auto-add suffix like ` (2)` if duplicated)
* `/abort` → force-abort current session generation
* `/reset` / `/restart` → reset bridge runtime state and create a new session
* `/status` → show runtime status (session / agent / model / pid / uptime)
* `/status cache` → show in-memory cache sizes (session maps / pending states / file store / dedupe sets)
* `/sessions` → list sessions (reply with `/sessions <id>` or `/sessions <index>` to bind)
* `/sessions delete 1,2,3` → batch delete sessions by index/id
* `/sessions delete all` → delete all sessions except current one
* `/maxFileSize <xmb>` → set upload file size limit (default 10MB)
* `/maxFileRetry <n>` → set resource download retry count (default 3)
* `/savefile` → ask user to upload file and save directly to local path (without LLM)
* `/sendfile <path>` → force-send a local file back via bot
* `/share` / `/unshare`
* `/compact` (alias `/summarize`)
* `/init`
* `/agent` → list available agents
* `/agent <index|name>` → bind agent for future prompts

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
Session batch deletion is supported via `/sessions delete ...`, and `/sessions delete all` keeps the current active session.
File upload size limit can be adjusted per chat with `/maxFileSize <xmb>` (default 10MB).
Use `/status cache` to quickly inspect current cache usage and troubleshoot memory growth.

If your OpenCode setup provides additional slash commands, they will still be forwarded via `session.command` unless explicitly handled above.

### Local File Return / Save (No-LLM path)

This bridge supports two direct file operations:

* `/sendfile <path>`: force-send a local file by path.
* `/savefile`: enter upload mode; the next uploaded file is saved to local disk and the saved path is returned.

These flows bypass LLM reasoning and are handled directly by bridge adapters.

---

## 🧾 Logging

The bridge now uses a unified logger and writes logs to file by default.

Environment variables:

* `BRIDGE_LOG_FILE` - custom log file path (default: `logs/bridge.log`)
* `BRIDGE_LOG_STDOUT` - enable/disable terminal log output (`true` by default)
* `BRIDGE_DEBUG` - enable debug-level logs (`false` by default)

Example:

```bash
BRIDGE_DEBUG=true BRIDGE_LOG_FILE=/tmp/bridge.log opencode web
```

You can also check the current log path via `/status` (`logFile` field).

---

## 🗂️ Cache Strategy

The bridge uses bounded in-memory caches to avoid unbounded growth during long-running sessions:

* LRU/TTL caches are used for message mapping and dedupe (platform adapters + event flow).
* File store caches (`seenFiles` / `pendingFiles`) are now pruned by TTL and size:
* `seenFiles`: 7 days TTL, up to 4000 entries per chat.
* `pendingFiles`: 24 hours TTL, up to 200 entries per chat.
* A global tracked-chat cap is applied to both file caches to limit total memory footprint.
* `/restart` now clears bridge runtime caches more completely (including Feishu/QQ dedupe sets and pending authorization state).

For debugging, run:

```bash
/status cache
```

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
[Quicj Start 🔗 ](https://github.com/YuanG1944/message-bridge-opencode-plugin/tree/main/config-guide/lark/GUIDE.md)

### Telegram (Bot API - Polling)

[Quick Start 🔗](https://github.com/YuanG1944/message-bridge-opencode-plugin/tree/main/config-guide/telegram/GUIDE.md)

### QQ 

[Quick Start 🔗](https://github.com/YuanG1944/message-bridge-opencode-plugin/blob/main/config-guide/qq/GUIDE.md)

### Optional file-bridge options

You can configure local file return behavior in `agent.message-bridge.options`:

* `auto_send_local_files` (`"true"` / `"false"`, default `false`)
* `auto_send_local_files_max_mb` (default `20`)
* `auto_send_local_files_allow_absolute` (`"true"` / `"false"`, default `false`)
* `file_store_dir` (local directory to save inbound uploaded files; supports relative/absolute/`file://` paths; default: `bridge_files`)
* `webhook_listen_port` (Telegram webhook local listen port, optional; fallback: callback_url port -> `18080`)

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
* [x] Telegram (Bot API / Polling + Webhook)
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
