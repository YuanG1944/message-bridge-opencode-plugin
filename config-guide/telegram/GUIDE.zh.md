## 🚀 快速开始 --- Telegram（Bot API）

## 1）创建机器人并获取 Token

1. 在 Telegram 中打开 `@BotFather`。
2. 执行 `/newbot`。
3. 复制返回的 token（例如 `123456:xxxxxx`）。

请妥善保管 token，不要泄露。

---

## 2）配置 OpenCode（`opencode.json`）

> 注意：建议所有配置项都使用**字符串类型**，避免解析问题。

### 轮询模式

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

### Webhook 模式

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

## 3）启动 OpenCode

```bash
opencode web
```

启动后，给机器人发一条消息即可验证。

---

## 4）行为说明

- 轮询模式下，同一个 bot token 同时只能有一个进程消费更新。
- webhook 模式需要公网可访问的 HTTPS 回调地址。
- 已支持桥接层 slash 命令（如 `/new`、`/models`、`/sessions`、`/status`）。
- `/start` 属于 Telegram 平台命令，桥接侧会过滤，不进入业务会话逻辑。

---

## 5）常见问题排查

### 报错：`Conflict: terminated by other getUpdates request`

原因：同一个 token 被多个进程同时轮询。

处理：
1. 关闭其它运行中的实例。
2. 保留一个轮询实例。
3. 或者改为 webhook 模式。

### 报错：`Unable to connect. Is the computer able to access the url?`

原因：当前机器无法访问 Telegram Bot API。

处理：
1. 检查代理/防火墙策略。
2. 检查 DNS 和出口网络。
3. 网络恢复后重试。

### Telegram 收到回复偏慢

可能原因：
1. Telegram API 请求往返和编辑限制。
2. 轮询参数配置偏保守。
3. 弱网下编辑/重试增加延迟。

建议：
1. 生产环境优先使用 webhook 模式。
2. 轮询模式可将 `polling_interval_ms` 设为 `200~300` 范围做平衡。
