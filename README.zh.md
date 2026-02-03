# OpenCode 消息桥插件（Message Bridge）

`message-bridge-opencode-plugin` 是一个为 **OpenCode Agent** 设计的 **通用消息桥插件**。
它的目标是让 AI Agent 可以通过 **统一的抽象层** 接入多个即时通讯平台。

该项目**最初只用于支持飞书（Feishu / Lark）**，
在完成稳定实现并经过实际使用验证后，升级为 **通用消息桥方案**，以便未来持续接入更多消息平台。

---

## ✨ 当前状态

### ✅ 已完全支持（可用于生产）

* **飞书 / Feishu / Lark**

  * 功能完整、稳定
  * 支持 **Webhook** 与 **WebSocket** 两种模式
  * 已完整适配 OpenCode 插件体系

### 🚧 开发中（优先级排序）

* **iMessage（下一优先目标）**
* 其他计划中的平台：

  * Telegram
  * Slack
  * Discord
  * WhatsApp（取决于 API 可用性）

> 插件架构已为多平台扩展做好设计，后续平台会逐步接入。

---

## ✨ 特性

* **通用消息抽象**

  * 一个 OpenCode Agent，对接多个 IM 平台
* **即插即用**

  * 完全兼容 OpenCode 插件系统
* **多通信模式**

  * `webhook`：推荐用于生产环境
  * `ws`（WebSocket）：适合本地开发调试，无需公网 IP
* **配置驱动**

  * 所有配置集中在 `opencode.json`
* **可扩展架构**

  * 新平台接入无需修改 Agent 核心逻辑

---

## ✅ Slash 命令支持

本插件**优先用 OpenCode API 实现关键命令**，其余自定义命令再走 `session.command`。
UI 相关命令（主题/编辑器/退出等）**不适合聊天场景**，因此不支持。

### 官方内置命令（TUI）

根据官方 TUI 文档，内置命令包括：

* `/connect`
* `/compact`（别名：`/summarize`）
* `/details`
* `/editor`
* `/exit`（别名：`/quit`、`/q`）
* `/export`
* `/help`
* `/init`
* `/models`
* `/new`（别名：`/clear`）
* `/redo`
* `/sessions`（别名：`/resume`、`/continue`）
* `/share`
* `/theme`
* `/thinking`
* `/undo`
* `/unshare`

### 已适配的命令

以下命令在桥接层通过 API 直接实现：

* `/help` → 列出自定义命令
* `/models` → 列出 provider 与模型
* `/new` → 创建并绑定新会话
* `/sessions` → 列出会话（回复 `/sessions <id>` 切换）
* `/share` / `/unshare`
* `/compact`（别名 `/summarize`）
* `/init`
* `/agent <name>` → 绑定后续对话的 Agent

### UI 命令（聊天不支持）

* `/connect`
* `/details`
* `/editor`
* `/export`
* `/exit`（`/quit`、`/q`）
* `/theme`
* `/thinking`

### 自定义命令

支持以下方式定义自定义命令：

* `opencode.json` 中的 `command` 字段，或
* `.opencode/commands/*.md` 文件。

### 会话 / Agent 切换

`/sessions` 会返回会话列表与可选项，结果会直接回到聊天窗口，你只需回复 `/sessions <id>` **或** `/sessions <序号>` 即可切换并绑定到目标会话。

如果你的 OpenCode 环境提供了其它 slash 命令，且未在上面专门适配，则仍会走 `session.command` 透传。

---

## 📦 安装

在 OpenCode Agent 配置目录中执行：

```bash
npm install message-bridge-opencode-plugin
```

> ⚠️ 由于 OpenCode 当前存在已知问题，暂时需要使用开发模式，详见下文。

---

## 🚀 快速开始

### ⚙️ 配置 (`opencode.json`)

> **注意：**
> 强烈建议所有配置项均使用 **字符串类型**，以避免解析问题。

### 飞书（Webhook 模式）

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

### 飞书（WebSocket 模式）

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

## 🚧 当前必须使用开发模式

由于 OpenCode 官方当前存在以下问题：

> **Issue:** `fn3 is not a function`
> [https://github.com/anomalyco/opencode/issues/7792](https://github.com/anomalyco/opencode/issues/7792)

暂时无法直接通过 npm 包使用插件，需要使用本地开发模式。

### 使用步骤

```bash
git clone https://github.com/YuanG1944/message-bridge-opencode-plugin.git
cd message-bridge-opencode-plugin
bun install
```

在 `opencode.json` 中引用本地路径即可。

---

## 🛣 开发路线图

* [x] 飞书 / Lark（已完成，稳定）
* [ ] iMessage（优先实现）
* [ ] Telegram
* [ ] Slack
* [ ] Discord
* [ ] 统一消息回复 / 会话抽象

---

## 🤝 参与贡献

欢迎提交：

* 新平台适配
* Bug 修复
* 文档改进
* 架构与设计讨论

---

## 📄 License

MIT License
