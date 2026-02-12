# OpenCode 消息桥插件（Message Bridge）

[English](https://github.com/YuanG1944/message-bridge-opencode-plugin/blob/main/README.md) | [中文](https://github.com/YuanG1944/message-bridge-opencode-plugin/blob/main/README.zh.md)

---

`message-bridge-opencode-plugin` 是一个为 **OpenCode Agent** 设计的 **通用消息桥插件**。
它的目标是让 AI Agent 可以通过 **统一的抽象层** 接入多个即时通讯平台。

该项目**最初只用于支持飞书（Feishu / Lark）**，
在完成稳定实现并经过实际使用验证后，升级为 **通用消息桥方案**，以便未来持续接入更多消息平台。

---

## ✨ 当前状态

### ✅ 已完全支持

* **飞书 / Feishu / Lark**

  * 功能完整、稳定
  * 支持图片/文件解析
  * 支持 '/' 命令
  * 支持 **Webhook** 与 **WebSocket** 两种模式
  * 适配 OpenCode 插件体系
* **Telegram（Bot API / 轮询 + Webhook）**

  * 支持接收文本消息
  * 支持常见媒体消息（图片/文件/视频/音频/语音/贴纸/动图）
  * 支持流式回复发送与编辑
  * 支持桥接层 slash 命令流程

### 🚧 开发中（优先级排序）

* **iMessage（下一优先目标）**
* 其他计划中的平台：

  * QQ
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
* `/maxFileSize`
* `/maxFileRetry`

### 已适配的命令

以下命令在桥接层通过 API 直接实现：

* `/help` → 列出自定义命令
* `/models` → 列出 provider 与模型
* `/new` → 创建并绑定新会话
* `/rename <title>` → 重命名当前会话（若重名自动追加 ` (2)`、` (3)`）
* `/abort` → 强制终止当前会话生成
* `/sessions` → 列出会话（回复 `/sessions <id>` 切换）
* `/maxFileSize <xmb>` → 设置上传文件大小限制（默认 10MB）
* `/maxFileRetry <n>` → 设置资源下载重试次数（默认 3）
* `/savefile` → 进入“直接保存上传文件”模式（不经过大模型）
* `/sendfile <path>` → 按本地路径强制回传文件
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
文件上传大小限制可通过 `/maxFileSize <xmb>` 调整（默认 10MB）。

如果你的 OpenCode 环境提供了其它 slash 命令，且未在上面专门适配，则仍会走 `session.command` 透传。

### 本地文件直传/直存（不走 LLM）

插件提供两条直接文件能力：

* `/sendfile <path>`：根据本地路径直接通过 Bot 回传文件。
* `/savefile`：进入上传等待态；你下一条上传的文件会直接保存到本地并返回路径。

以上流程都由桥接层直接处理，不经过大模型。

---

## 🧾 日志配置

桥接日志已统一收口到同一套 logger，并默认写入文件。

可用环境变量：

* `BRIDGE_LOG_FILE`：自定义日志文件路径（默认：`logs/bridge.log`）
* `BRIDGE_LOG_STDOUT`：是否输出到终端（默认 `true`）
* `BRIDGE_DEBUG`：是否开启 debug 级别日志（默认 `false`）

示例：

```bash
BRIDGE_DEBUG=true BRIDGE_LOG_FILE=/tmp/bridge.log opencode web
```

也可以通过 `/status` 查看当前日志路径（`logFile` 字段）。

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

- 飞书配置 
	
	[快速开始 🔗 ](https://github.com/YuanG1944/message-bridge-opencode-plugin/tree/main/config-guide/lark/GUIDE.zh.md)

- Telegram 配置

  [快速开始 🔗 ](https://github.com/YuanG1944/message-bridge-opencode-plugin/tree/main/config-guide/telegram/GUIDE.zh.md)

- QQ 配置

  [快速开始 🔗 ](https://github.com/YuanG1944/message-bridge-opencode-plugin/tree/main/config-guide/qq/GUIDE.zh.md)

可选文件桥配置（`agent.message-bridge.options`）：

* `auto_send_local_files`（`"true"` / `"false"`，默认 `false`）
* `auto_send_local_files_max_mb`（默认 `20`）
* `auto_send_local_files_allow_absolute`（`"true"` / `"false"`，默认 `false`）
* `file_store_dir`（上传文件本地保存目录；支持相对路径/绝对路径/`file://`；默认 `bridge_files`）
* `webhook_listen_port`（Telegram webhook 本地监听端口，可选；回退顺序：callback_url 端口 -> `18080`）

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
* [x] QQ
* [x] Telegram（Bot API / 轮询 + Webhook）
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
