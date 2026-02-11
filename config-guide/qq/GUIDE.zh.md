## 🚀 快速开始 --- QQ官方机器人（单聊和群聊）

### ⚙️ Opencode 配置 (`opencode.json`)

> **注意：**
> 强烈建议所有配置项均使用 **字符串类型**，以避免解析问题。

### QQ官方机器人（Webhook 模式）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"],
  "agent": {
    "qq-bridge": {
      "disable": false,
      "description": "QQ Bridge Plugin",
      "options": {
        "mode": "webhook",
        "app_id": "your_app_id",
        "app_secret": "your_app_secret",
        "callback_url": "https://your-domain.com:8080",
        "webhook_listen_port": "8080"
      }
    }
  }
}
```

### QQ官方机器人（WebSocket 模式）

暂不支持

---

### ⚙️ QQ开放平台配置

### 访问 [QQ开放平台](https://bot.q.qq.com/)

1. #### 创建机器人应用

   - 登录QQ开放平台
   - 选择 **机器人** -> **创建机器人**
   - 填写机器人基本信息（名称、头像、简介等）
   - 创建完成后，点击开发管理记录 **AppID** 和 **AppSecret**

2. #### 🔒 配置机器人回调事件

   - 进入 **开发** -> **回调配置**
   - 确保添加以下事件：
     - **C2C消息事件** - 用于接收私聊消息
     - **群聊消息@事件** - 用于接收群聊消息
     - **创建互动事件** - 用于配置事件回调地址

3. #### 🌐 配置请求地址

  -**Webhook 模式（推荐）：**
     - 填写 **请求地址**（需要公网可访问的 HTTPS 地址）
       - 如果有服务器，直接使用域名
       - 如果没有服务器，可以使用 `cloudflared` 创建隧道：
         ```shell
         cloudflared tunnel --url http://127.0.0.1:8080
         ```
       - 从日志中获取公网地址，填入回调地址
     - 点击 **保存**

   - 在 **事件订阅** 页面，添加以下事件：
     - `C2C_MESSAGE_CREATE` - 私聊消息事件（必需，用于接收私聊消息）
     - `GROUP_AT_MESSAGE_CREATE` - 群聊@消息事件（必需，用于接收群聊@消息）
     - 其他事件按需添加

4. #### 🤖 使用机器人

   - 进入 **开发** -> **沙箱配置**
   - 将自己和需要测试的QQ群配置进去
   - **私聊**：用户直接添加机器人为好友并发送消息
   - **群聊**：将机器人添加到QQ群，在群内@机器人发送消息

5. #### 启动 `opencode`

   ```shell
   opencode web
   ```

   启动后，在QQ私聊机器人或者群聊中@机器人发送消息即可验证。

---

## 📋 配置项说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `app_id` | string | 是 | 机器人的 AppID |
| `token` | string | 是 | 机器人的 Token |
| `app_secret` | string | 是 | 连接模式：`webhook` 或 `ws`（暂不支持） |
| `callback_url` | string | 否 | Webhook 回调地址（webhook 模式必填） |
| `webhook_listen_port` | number | 否 | Webhook 监听端口（默认 8080） |

---

## 🔧 常见问题

### 1. 回调地址验证失败

**原因：** QQ开放平台需要验证回调地址的有效性

**处理：**
- 确保回调地址是 HTTPS（生产环境）或使用 cloudflared 隧道
- 确保服务器可以正常访问
- 检查端口是否正确开放

### 2. Webhook 模式无法连接

**处理：**
- 使用 `cloudflared` 创建隧道：
  ```shell
  cloudflared tunnel --url http://127.0.0.1:8080
  ```
- 将生成的 HTTPS 地址填入回调地址
- 确保 OpenCode 正在运行

---

## 📚 参考资源

- [QQ开放平台](https://bot.q.qq.com/)
