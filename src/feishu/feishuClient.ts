// src/feishu/feishuClient.ts
import * as lark from '@larksuiteoapi/node-sdk';
import * as http from 'http';
import * as crypto from 'crypto';

import type { FeishuConfig, IncomingMessageHandler } from '../types';
import { globalState } from '../utils';

function clip(s: string, n = 2000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + ` ... (clipped, len=${s.length})` : s;
}
function looksLikeJsonCard(s: string) {
  const trimmed = s.trim();
  // 必须以 { 开头，} 结尾，且包含 elements 或 header 关键字，才是飞书卡片
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;

  try {
    const obj = JSON.parse(trimmed);
    // 飞书卡片特征：必须是对象，通常有 elements 数组
    return (
      !!obj && typeof obj === 'object' && (Array.isArray(obj.elements) || (obj as any).card_link)
    );
  } catch {
    return false;
  }
}

const processedMessageIds: Set<string> = globalState.__feishu_processed_ids || new Set<string>();
globalState.__feishu_processed_ids = processedMessageIds;

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
  private callbackUrl?: string;
  private callbackPort?: number;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.apiClient = new lark.Client({
      appId: config.app_id,
      appSecret: config.app_secret,
    });
    if (config.callback_url) {
      this.callbackUrl = config.callback_url;
      try {
        const u = new URL(this.callbackUrl);
        this.callbackPort = u.port ? Number(u.port) : undefined;
      } catch {
        // ignore
      }
    }
  }

  private isMessageProcessed(messageId: string): boolean {
    if (processedMessageIds.has(messageId)) {
      console.log(`[Feishu] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value || '';
      processedMessageIds.delete(first);
    }
    return false;
  }

  private parseAndCleanContent(contentJson: string, mentions?: any[]): string {
    try {
      const content = JSON.parse(contentJson);
      let text: string = content.text || '';
      if (mentions && mentions.length > 0) {
        mentions.forEach((m: any) => {
          if (m.key) {
            const regex = new RegExp(m.key, 'g');
            text = text.replace(regex, '');
          }
        });
      }
      return text.trim();
    } catch (e: any) {
      console.error(`[Feishu] ❌ Content Parse Error!`, e);
      return '';
    }
  }

  private makeCard(text: string): string {
    const raw = text ?? '';

    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && Array.isArray(obj.elements)) {
          return trimmed;
        }
      } catch {
        // 不是合法 JSON，就走 fallback 包装
      }
    }

    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: raw },
        },
      ],
    });
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    try {
      const isCard = looksLikeJsonCard(text);

      const finalContent = isCard ? text : this.makeCard(text);

      const res = await this.apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive', // 永远使用 interactive
          content: finalContent,
        },
      });
      if (res.code === 0 && res.data?.message_id) return res.data.message_id;
      console.error('[Feishu] ❌ Send failed:', res);
      return null;
    } catch (e) {
      console.error('[Feishu] ❌ Failed to send:', e);
      return null;
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const res = await this.apiClient.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: text,
        },
      });

      return res.code === 0;
    } catch {
      return false;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res.data?.reaction_id || null;
    } catch {
      return null;
    }
  }

  async removeReaction(messageId: string, reactionId: string) {
    if (!reactionId) return;
    try {
      await this.apiClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // ignore
    }
  }

  async startWebSocket(onMessage: IncomingMessageHandler) {
    if (globalState.__feishu_ws_client_instance) return;

    this.wsClient = new lark.WSClient({
      appId: this.config.app_id,
      appSecret: this.config.app_secret,
      loggerLevel: lark.LoggerLevel.info,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const { message, sender } = data;
        const messageId = message.message_id;
        const chatId = message.chat_id;
        const senderId = sender?.sender_id?.open_id || '';

        if (this.isMessageProcessed(messageId)) return;

        const text = this.parseAndCleanContent(message.content, message.mentions);
        if (!text) return;

        await onMessage(chatId, text, messageId, senderId);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    globalState.__feishu_ws_client_instance = this.wsClient;
    console.log('✅ Feishu WebSocket Connected!');
  }

  async startWebhook(onMessage: IncomingMessageHandler) {
    if (this.httpServer) return;

    const port = this.callbackPort || 8080;
    this.httpServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (!rawBody) return res.end();

          let body: any = JSON.parse(rawBody);

          if (body.encrypt && this.config.encrypt_key) {
            const decrypted = decryptEvent(body.encrypt, this.config.encrypt_key);
            body = JSON.parse(decrypted);
          }

          if (body.type === 'url_verification') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ challenge: body.challenge }));
          }

          if (body.header?.event_type === 'im.message.receive_v1') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            const event = body.event;
            const messageId = event.message?.message_id;
            const chatId = event.message?.chat_id;
            const senderId = event.sender?.sender_id?.open_id || '';

            if (messageId && chatId && !this.isMessageProcessed(messageId)) {
              const text = this.parseAndCleanContent(event.message.content, event.message.mentions);
              if (text) {
                onMessage(chatId, text, messageId, senderId).catch(err => {
                  console.error('[Feishu Webhook] ❌ Handler Error:', err);
                });
              }
            }
            return;
          }

          res.writeHead(200);
          res.end('OK');
        } catch (e) {
          console.error('[Feishu Webhook] ❌ Server Error:', e);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      console.log(`✅ Feishu Webhook Server listening on port ${port}`);
      if (this.callbackUrl) {
        console.log(`[Feishu] Callback URL: ${this.callbackUrl}`);
      } else {
        console.log('[Feishu] Callback URL: http://<public-host>:' + port);
      }
    });
  }

  async stop() {
    if (this.wsClient) {
      this.wsClient = null;
      globalState.__feishu_ws_client_instance = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}
