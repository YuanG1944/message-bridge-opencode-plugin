## 🚀 Quick Start --- QQ Official Bot (Private Chat & Group Chat)

### ⚙️ Opencode Configuration (`opencode.json`)

> **Note:**
> It is strongly recommended to use **string types** for all configuration options to avoid parsing issues.

### QQ Official Bot (Webhook Mode)

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

### QQ Official Bot (WebSocket Mode)

Not supported yet.

---

### ⚙️ QQ Open Platform Configuration

### Visit [QQ Open Platform](https://bot.q.qq.com/)

1. #### Create Bot Application

   - Log in to QQ Open Platform
   - Go to **Bot** -> **Create Bot**
   - Fill in basic bot information (name, avatar, description, etc.)
   - After creation, go to Developer Management and record **AppID** and **AppSecret**

2. #### 🔒 Configure Bot Callback Events

   - Go to **Developer** -> **Callback Configuration**
   - Make sure to add the following events:
     - **C2C Message Event** - For receiving private chat messages
     - **Group @ Message Event** - For receiving group @ messages
     - **Interaction Created Event** - For configuring callback URL validation

3. #### 🌐 Configure Request URL

  -**Webhook Mode (Recommended):**
    - Fill in the **Request URL** (must be a publicly accessible HTTPS address)
      - If you have a server, use your own domain
      - If you do not have a server, you can use `cloudflared` to create a tunnel:
        ```shell
        cloudflared tunnel --url http://127.0.0.1:8080
        ```
      - Get the public address from the logs and fill it into the callback URL
    - Click **Save**

  - On the **📡 Event Subscription** page, add the following events:
    - `C2C_MESSAGE_CREATE` - Private chat message event (required, for receiving private messages)
    - `GROUP_AT_MESSAGE_CREATE` - Group @ message event (required, for receiving group @ messages)
    - Other events as needed

4. #### 🤖 Use the Bot

   - Go to **Developer** -> **Sandbox Configuration**
   - Add yourself and the QQ groups you want to test to the sandbox
   - **Private Chat**: Users add the bot as a friend and send messages directly
   - **Group Chat**: Add the bot to a QQ group, then @mention the bot in the group to send messages

5. #### Start `opencode`

   ```shell
   opencode web
   ```

   After starting, you can send messages to the bot in QQ private chat or @mention the bot in group chat to verify everything works.

---

## 📋 Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `app_id` | string | Yes | Bot AppID |
| `token` | string | Yes | Bot Token (not used in current implementation, reserved for compatibility) |
| `app_secret` | string | Yes | App Secret used to obtain access token |
| `callback_url` | string | No | Webhook callback URL (required in webhook mode) |
| `webhook_listen_port` | number | No | Webhook listen port (default 8080) |

---

## 🔧 Troubleshooting

### 1. Callback URL Verification Failed

**Reason:** QQ Open Platform needs to verify the validity of the callback URL

**Solution:**
- Ensure the callback URL is HTTPS in production, or use a cloudflared tunnel
- Ensure the server is accessible from the internet
- Check if the port is correctly opened

### 2. Webhook Mode Cannot Connect

**Solution:**
- Use `cloudflared` to create a tunnel:
  ```shell
  cloudflared tunnel --url http://127.0.0.1:8080
  ```
- Fill the generated HTTPS address into the callback URL
- Ensure OpenCode is running

---

## 📚 References

- [QQ Open Platform](https://bot.q.qq.com/)

