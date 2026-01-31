import * as lark from '@larksuiteoapi/node-sdk';
import * as http from 'http';
import * as crypto from 'crypto';
import type { FeishuConfig } from './types';

const globalState = globalThis as any;

// Deduplication cache
const processedMessageIds = globalState.__feishu_processed_ids || new Set<string>();
globalState.__feishu_processed_ids = processedMessageIds;

type MessageHandler = (
  chatId: string,
  text: string,
  messageId: string,
  senderId: string,
) => Promise<void>;

/**
 * 🔐 Decrypt Feishu Event (AES-256-CBC)
 */
function decryptEvent(encrypted: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encrypted, 'base64');
  const iv = encryptedBuffer.subarray(0, 16);
  const ciphertext = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(ciphertext, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class FeishuClient {
  private apiClient: lark.Client;
  private config: FeishuConfig;
  private wsClient: lark.WSClient | null = null;
  private httpServer: http.Server | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.apiClient = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  // --- Helpers ---

  private isMessageProcessed(messageId: string): boolean {
    if (processedMessageIds.has(messageId)) {
      console.log(`[Feishu] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 1000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }
    return false;
  }

  private parseAndCleanContent(contentJson: string, mentions?: any[]): string {
    try {
      const content = JSON.parse(contentJson);
      let text = content.text || '';
      if (mentions && mentions.length > 0) {
        text = text.replace(/@\S+\s*/g, '').trim();
      }
      return text.trim();
    } catch (e) {
      console.error('[Feishu] ⚠️ Failed to parse message content JSON:', e);
      return '';
    }
  }

  // --- Public Methods ---

  public async sendMessage(chatId: string, text: string) {
    try {
      await this.apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      console.log(`[Feishu] ✅ Message sent to ${chatId}`);
    } catch (error) {
      console.error('[Feishu] ❌ Failed to send message:', error);
    }
  }

  public async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res.data?.reaction_id || null;
    } catch (error) {
      console.warn(`[Feishu] Failed to add reaction (${emojiType}):`, error);
      return null;
    }
  }

  public async removeReaction(messageId: string, reactionId: string) {
    if (!reactionId) return;
    try {
      await this.apiClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (error) {
      // ignore
    }
  }

  /**
   * Start WebSocket Listener (Long Connection)
   */
  public async startWebSocket(onMessage: MessageHandler) {
    if (globalState.__feishu_ws_client_instance) {
      console.log('[Feishu WS] ⚠️ Active WebSocket connection detected. Skipping initialization.');
      return;
    }
    console.log('[Feishu WS] Initializing WebSocket Client...');

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const chatId = data.message.chat_id;
        const messageId = data.message.message_id;
        const senderId = (data.message as any).sender?.sender_id?.open_id || '';

        if (this.isMessageProcessed(messageId)) return;

        const text = this.parseAndCleanContent(data.message.content, data.message.mentions);
        if (!text) return;

        console.log(`[Feishu WS] 📩 Received message: "${text}" from ${senderId}`);
        await onMessage(chatId, text, messageId, senderId);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    globalState.__feishu_ws_client_instance = this.wsClient;
    console.log('✅ Feishu WebSocket Connected successfully!');
  }

  /**
   * ✅ Start Webhook Server (HTTP Mode)
   * Manual implementation to handle Encryption and URL Verification transparently.
   */
  public async startWebhook(onMessage: MessageHandler) {
    if (this.httpServer) {
      console.log('[Feishu Webhook] ⚠️ Server is already running.');
      return;
    }

    const port = this.config.port || 8080;

    console.log(`[Feishu Webhook] Starting HTTP Server on port: ${port} (Accepting all paths)...`);

    this.httpServer = http.createServer((req, res) => {
      // 1. Only accept POST
      if (req.method !== 'POST') {
        console.log(`[Feishu Webhook] 🚫 Blocked ${req.method} request`);
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }

      // 2. Read Body
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));

      req.on('end', async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (!rawBody) {
            console.log('[Feishu Webhook] Received empty body.');
            res.end('ok');
            return;
          }

          let body: any = JSON.parse(rawBody);

          // 3. Handle Encryption
          if (body.encrypt) {
            console.log('[Feishu Webhook] 🔐 Encrypted payload detected.');
            if (this.config.encryptKey) {
              try {
                const decrypted = decryptEvent(body.encrypt, this.config.encryptKey);
                body = JSON.parse(decrypted);
                console.log('[Feishu Webhook] 🔓 Decryption successful.');
              } catch (e) {
                console.error(
                  '[Feishu Webhook] ❌ Decryption failed. Please check FEISHU_ENCRYPT_KEY.',
                  e,
                );
                res.writeHead(500);
                res.end('Decryption Failed');
                return;
              }
            } else {
              console.warn(
                '[Feishu Webhook] ⚠️ Received encrypted data but no FEISHU_ENCRYPT_KEY configured!',
              );
            }
          }

          // 4. 🔥 URL Verification (Challenge)
          if (body.type === 'url_verification') {
            console.log(
              `[Feishu Webhook] 🟢 Received URL Verification Challenge: ${body.challenge}`,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: body.challenge }));
            return;
          }

          // 5. Handle Message Event
          const eventType = body.header?.event_type;

          if (eventType === 'im.message.receive_v1') {
            // Acknowledge immediately
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            // Async processing
            const event = body.event;
            const messageId = event.message?.message_id;
            const chatId = event.message?.chat_id;
            const senderId = event.sender?.sender_id?.open_id;

            if (messageId && chatId) {
              if (this.isMessageProcessed(messageId)) return;

              const text = this.parseAndCleanContent(event.message.content, event.message.mentions);
              if (text) {
                console.log(`[Feishu Webhook] 📩 Message: "${text}" (User: ${senderId})`);

                onMessage(chatId, text, messageId, senderId || '').catch(err => {
                  console.error('[Feishu Webhook] ❌ Logic Error inside handler:', err);
                });
              } else {
                console.log('[Feishu Webhook] Received message but extracted text was empty.');
              }
            }
            return;
          }

          // Log other events
          console.log(`[Feishu Webhook] ℹ️ Ignored event type: ${eventType}`);

          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          console.error('[Feishu Webhook] ❌ Internal Request Error:', error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      console.log(`✅ Feishu Webhook Server listening: http://localhost:${port}`);
    });
  }
}
