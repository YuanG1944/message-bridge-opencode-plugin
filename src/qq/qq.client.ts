// src/qq/qq.client.ts
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as crypto from 'crypto';
import { promisify } from 'util';

import type { QQConfig, IncomingMessageHandler } from '../types';
import type { FilePartInput } from '@opencode-ai/sdk';
import { bridgeLogger } from '../logger';
import {
  DEFAULT_MAX_FILE_MB,
  DEFAULT_MAX_FILE_RETRY,
  ERROR_HEADER,
  globalState,
  sleep,
} from '../utils';
import { QQRenderer } from './qq.renderer';
import { sanitizeTemplateMarkers } from '../utils';

function clip(s: string, n = 2000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + ` ... (clipped, len=${s.length})` : s;
}

// QQ官方机器人API基础地址
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_OAUTH_BASE = 'https://bots.qq.com/app/getAppAccessToken';

const processedMessageIds: Set<string> =
  globalState.__qq_processed_ids || new Set<string>();
globalState.__qq_processed_ids = processedMessageIds;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

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

// QQ回调地址验证：使用ed25519签名
// 根据QQ开放平台要求，使用botSecret生成ed25519密钥并签名
// 参考Go实现：
// 1. botSecret重复到32字节作为种子
// 2. 使用ed25519.GenerateKey(reader)生成密钥对
// 3. 消息 = eventTs + plainToken（字符串拼接）
// 4. 使用ed25519.Sign签名
// 5. 返回hex编码的签名
function validateQQCallbackEd25519(plainToken: string, eventTs: string, botSecret: string): string {
  const ED25519_SEED_SIZE = 32;
  
  // 按照Go代码逻辑：字符串重复直到达到32字节
  let seed = botSecret;
  while (seed.length < ED25519_SEED_SIZE) {
    seed = seed + seed; // 字符串重复（Go的strings.Repeat）
  }
  seed = seed.slice(0, ED25519_SEED_SIZE); // 截断到32字节
  
  // 构造消息：event_ts + plain_token（字符串拼接，不是Buffer拼接）
  const message = eventTs + plainToken;
  
  try {
    // Node.js的crypto模块不支持从种子确定性生成ed25519密钥
    // 我们需要使用@noble/ed25519库来实现
    // 尝试动态加载，如果不存在则使用fallback
    let ed25519: any;
    try {
      // 尝试使用@noble/ed25519库
      ed25519 = require('@noble/ed25519');
    } catch {
      // 如果库不存在，尝试使用tweetnacl
      try {
        ed25519 = require('tweetnacl');
        bridgeLogger.info('[QQ] tweetnacl library loaded');
      } catch {
        bridgeLogger.warn('[QQ] ed25519 library not found, using fallback method');
        // Fallback: 使用HMAC-SHA256（可能不被QQ接受）
        const seedBuffer = Buffer.from(seed, 'utf8');
        const keyMaterial = crypto.createHmac('sha256', seedBuffer).digest();
        const signature = crypto.createHmac('sha256', keyMaterial).update(Buffer.from(message, 'utf8')).digest('hex');
        return signature;
      }
    }
    
    // 使用@noble/ed25519或tweetnacl生成密钥对
    const seedBuffer = Buffer.from(seed, 'utf8');
    const seedUint8 = new Uint8Array(seedBuffer);
    const messageUint8 = new Uint8Array(Buffer.from(message, 'utf8'));
    
    if (ed25519.getPublicKey && ed25519.sign) {
      // @noble/ed25519 API
      // 私钥就是32字节的种子
      const signature = ed25519.sign(messageUint8, seedUint8);
      return Buffer.from(signature).toString('hex');
    } else if (ed25519.sign && ed25519.sign.detached && ed25519.sign.keyPair) {
      // tweetnacl API
      // tweetnacl.sign.keyPair.fromSeed(seed) 生成密钥对
      const keyPair = ed25519.sign.keyPair.fromSeed(seedUint8);
      // tweetnacl.sign.detached(message, secretKey) 进行签名
      const signature = ed25519.sign.detached(messageUint8, keyPair.secretKey);
      return Buffer.from(signature).toString('hex');
    } else {
      // 尝试直接使用tweetnacl的简化API
      if (ed25519.sign && typeof ed25519.sign === 'function') {
        // 可能是旧版本的tweetnacl
        const keyPair = (ed25519 as any).sign.keyPair.fromSeed(seedUint8);
        const signature = (ed25519 as any).sign.detached(messageUint8, keyPair.secretKey);
        return Buffer.from(signature).toString('hex');
      }
      throw new Error('Unsupported ed25519 library');
    }
  } catch (e) {
    bridgeLogger.error('[QQ] ed25519 signature generation failed:', e);
    bridgeLogger.warn('[QQ] Falling back to HMAC-SHA256 (may not be accepted by QQ)');
    // Fallback: 使用HMAC-SHA256
    const seedBuffer = Buffer.from(seed, 'utf8');
    const keyMaterial = crypto.createHmac('sha256', seedBuffer).digest();
    const signature = crypto.createHmac('sha256', keyMaterial).update(Buffer.from(message, 'utf8')).digest('hex');
    return signature;
  }
}

function inferMimeFromFilename(filename?: string): string | undefined {
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  if (!ext) return undefined;
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.mp4':
      return 'video/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

// QQ官方机器人消息类型（单聊和群聊）
type QQMessage = {
  id: string;
  chat_type: 'group' | 'c2c'; // 群聊或私聊
  group_openid?: string; // 群聊ID（群聊时使用）
  openid?: string; // 私聊用户ID（私聊时使用）
  content: string;
  author: {
    user_openid?: string; // 用户openid（私聊）
    member_openid?: string; // 群成员openid（群聊）
  };
  attachments?: Array<{
    content_type?: string;
    filename?: string;
    height?: number;
    size?: number;
    url?: string;
    width?: number;
  }>;
  image?: string;
  image_url?: string;
  msg_seq?: number;
  msg_type?: number; // 消息类型：0-文本，2-图片，3-语音，4-视频，5-文件
};

type QQEvent = {
  id: string;
  type: number;
  d?: Record<string, unknown>;
};

type QQApiResponse<T> = {
  code: number;
  message?: string;
  data?: T;
};

export class QQClient {
  private config: QQConfig;
  private httpServer: http.Server | null = null;
  private callbackUrl?: string;
  private callbackPort?: number;
  private renderer: QQRenderer;
  private wsClient: WebSocket | null = null;
  private wsIntents = 0 | 1 << 9 | 1 << 30; // GUILD_MESSAGES | DIRECT_MESSAGE
  private accessToken: string | null = null;
  private accessTokenExpiresAt: number = 0;
  private accessTokenPromise: Promise<string> | null = null;

  constructor(config: QQConfig) {
    this.config = config;
    this.renderer = new QQRenderer();
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
      bridgeLogger.info(`[QQ] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value || '';
      processedMessageIds.delete(first);
    }
    return false;
  }

  /**
   * 获取 access token
   * 使用 appId 和 clientSecret 调用 QQ 开放平台接口获取 access token
   */
  private async fetchAccessToken(): Promise<string> {
    try {
      bridgeLogger.info('[QQ] Fetching access token...');
      const response = await axios({
        method: 'POST',
        url: QQ_OAUTH_BASE,
        data: {
          appId: this.config.app_id,
          clientSecret: this.config.secret,
        },
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.status !== 200 || !response.data) {
        throw new Error(`Failed to get access token: status=${response.status}`);
      }

      const { access_token, expires_in } = response.data;
      if (!access_token) {
        throw new Error('Access token not found in response');
      }

      // 设置过期时间，提前 5 分钟刷新（expires_in 单位是秒）
      const expiresIn = typeof expires_in === 'number' ? expires_in : 7200;
      this.accessTokenExpiresAt = Date.now() + (expiresIn - 300) * 1000; // 提前5分钟刷新
      this.accessToken = access_token;

      bridgeLogger.info(`[QQ] Access token obtained, expires in ${expiresIn}s`);
      return access_token;
    } catch (error) {
      bridgeLogger.error('[QQ] Failed to fetch access token:', error);
      throw error;
    }
  }

  /**
   * 获取有效的 access token（带缓存和自动刷新）
   */
  private async getValidAccessToken(): Promise<string> {
    // 如果 token 仍然有效，直接返回
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    // 如果正在获取 token，等待现有的请求完成
    if (this.accessTokenPromise) {
      return await this.accessTokenPromise;
    }

    // 创建新的获取 token 请求
    this.accessTokenPromise = this.fetchAccessToken().finally(() => {
      this.accessTokenPromise = null;
    });

    return await this.accessTokenPromise;
  }

  /**
   * 根据 chatId 构建消息 endpoint
   * chatId格式：group_{group_openid} 或 c2c_{openid}
   */
  private buildMessageEndpoint(chatId: string, messageId?: string): string {
    const isGroup = chatId.startsWith('group_');
    const targetId = chatId.replace(/^(group_|c2c_)/, '');
    
    if (messageId) {
      // 编辑消息
      return isGroup 
        ? `/v2/groups/${targetId}/messages/${messageId}` 
        : `/v2/users/${targetId}/messages/${messageId}`;
    } else {
      // 发送消息
      return isGroup 
        ? `/v2/groups/${targetId}/messages` 
        : `/v2/users/${targetId}/messages`;
    }
  }

  /**
   * 根据 chatId 构建文件上传 endpoint
   */
  private buildFileEndpoint(chatId: string): string {
    const isGroup = chatId.startsWith('group_');
    const targetId = chatId.replace(/^(group_|c2c_)/, '');
    return isGroup 
      ? `${QQ_API_BASE}/v2/groups/${targetId}/files` 
      : `${QQ_API_BASE}/v2/users/${targetId}/files`;
  }

  private async makeRequest<T>(
    method: string,
    endpoint: string,
    data?: unknown,
  ): Promise<QQApiResponse<T>> {
    const url = `${QQ_API_BASE}${endpoint}`;
    const accessToken = await this.getValidAccessToken();
    const headers: Record<string, string> = {
      'Authorization': `QQBot ${accessToken}`,
      'Content-Type': 'application/json',
    };

    bridgeLogger.info(`[QQ] API Request: ${method} ${url}`);
    bridgeLogger.info(`[QQ] Request headers:`, headers);
    bridgeLogger.info(`[QQ] Request data:`, data);

    try {
      const response = await axios({
        method,
        url,
        headers,
        data,
        timeout: 30000,
        validateStatus: () => true,
      });

      bridgeLogger.debug(`[QQ] API Response: status=${response.status}`, response.data);

      const result: QQApiResponse<T> = {
        code: response.status,
        data: response.data,
      };

      if (response.status >= 400) {
        result.message = response.data?.message || response.statusText || 'Unknown error';
        // 如果响应体中有code字段，使用它
        if (response.data && typeof response.data === 'object' && 'code' in response.data) {
          result.code = (response.data as any).code;
        }
      }

      return result;
    } catch (error) {
      bridgeLogger.error(`[QQ] Request failed: ${endpoint}`, error);
      return {
        code: 500,
        message: getErrorMessage(error),
      };
    }
  }

  private decodeDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (!match) return null;
    const mime = match[1];
    const base64 = match[2];
    try {
      const buffer = Buffer.from(base64, 'base64');
      return { mime, buffer };
    } catch {
      return null;
    }
  }

  private async fetchUrlToBuffer(
    urlStr: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; mime?: string; filename?: string }> {
    const url = new URL(urlStr);
    const res = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    const status = res.status || 0;
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }

    const contentLengthRaw = res.headers?.['content-length'];
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
    if (contentLength && contentLength > maxBytes) {
      throw new Error('Content too large');
    }

    const buffer: Buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || '');
    if (buffer.length > maxBytes) {
      throw new Error('Content too large');
    }

    const mime = (res.headers?.['content-type'] as string | undefined)?.split(';')[0]?.trim();
    const filename =
      path.basename(url.pathname) || undefined;
    return { buffer, mime, filename };
  }

  async sendMessage(chatId: string, text: string, msgId?: string): Promise<string | null> {
    try {
      const content = this.renderer.render(text);
      const endpoint = this.buildMessageEndpoint(chatId);
      bridgeLogger.info(`[QQ] sendMessage endpoint: ${endpoint}`);
      
      const isGroup = chatId.startsWith('group_');
      const requestData: Record<string, unknown> = {
        content,
        msg_type: 0, // 文本消息
      };
      
      // 群聊时，如果提供了 msg_id，添加到请求中（用于回复消息）
      if (isGroup && msgId) {
        requestData.msg_id = msgId;
        bridgeLogger.debug(`[QQ] sending reply message with msg_id=${msgId} in group chat`);
      }
      
      const res = await this.makeRequest<{ id: string; msg_id: string }>('POST', endpoint, requestData);

      if (res.code === 200 && (res.data?.id || res.data?.msg_id)) {
        return res.data.id || res.data.msg_id || null;
      }

      bridgeLogger.error(`[QQ] Send failed:`, res);
      return null;
    } catch (e) {
      bridgeLogger.error('[QQ] ❌ Failed to send:', e);
      return null;
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const content = this.renderer.render(text);
      const endpoint = this.buildMessageEndpoint(chatId, messageId);
      bridgeLogger.info(`[QQ] editMessage endpoint: ${endpoint}`);
      const res = await this.makeRequest('PATCH', endpoint, {
        content,
      });

      return res.code === 0 || res.code === 200;
    } catch (e) {
      bridgeLogger.error(`[QQ] ❌ editMessage failed: msg=${messageId}`, e);
      return false;
    }
  }

  async sendFileAttachment(
    chatId: string,
    file: { filename?: string; mime?: string; url: string },
  ): Promise<boolean> {
    const { url, filename } = file;
    if (!url) return false;

    bridgeLogger.info(
      `[QQ] 📎 sendFileAttachment url=${url.slice(0, 120)}${url.length > 120 ? '...' : ''} filename=${filename || ''} mime=${file.mime || ''}`,
    );

    let buffer: Buffer | null = null;
    let mime = file.mime || '';
    let finalName = filename || '';

    if (url.startsWith('data:')) {
      const decoded = this.decodeDataUrl(url);
      if (!decoded) {
        bridgeLogger.warn('[QQ] ⚠️ Skip file: invalid data URL.');
        return false;
      }
      buffer = decoded.buffer;
      if (!mime) mime = decoded.mime;
      bridgeLogger.info(`[QQ] ✅ data URL decoded size=${buffer.length} mime=${mime}`);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      const maxBytes = mime.startsWith('image/') ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
      try {
        bridgeLogger.info(`[QQ] ⬇️ downloading url (max=${maxBytes} bytes)`);
        const res = await this.fetchUrlToBuffer(url, maxBytes);
        buffer = res.buffer;
        if (!mime) mime = res.mime || '';
        if (!finalName) finalName = res.filename || '';
        bridgeLogger.info(
          `[QQ] ✅ download ok size=${buffer.length} mime=${mime} filename=${finalName}`,
        );
      } catch (e) {
        bridgeLogger.error('[QQ] ❌ Download file failed:', e);
        return false;
      }
    } else if (url.startsWith('file://') || path.isAbsolute(url)) {
      try {
        const absPath = url.startsWith('file://') ? fileURLToPath(url) : url;
        buffer = await fs.readFile(absPath);
        if (!finalName) finalName = path.basename(absPath);
        bridgeLogger.info(
          `[QQ] ✅ local file loaded size=${buffer.length} path=${absPath} filename=${finalName}`,
        );
      } catch (e) {
        bridgeLogger.error('[QQ] ❌ Read local file failed:', e);
        return false;
      }
    } else {
      bridgeLogger.warn('[QQ] ⚠️ Skip file: unsupported URL scheme.');
      return false;
    }

    if (!buffer) return false;
    if (!mime) mime = inferMimeFromFilename(finalName) || 'application/octet-stream';

    try {
      // QQ频道机器人使用multipart/form-data上传文件
      // 尝试使用form-data包，如果不存在则使用手动构建multipart
      const accessToken = await this.getValidAccessToken();
      let formData: any;
      let headers: Record<string, string> = {
        'Authorization': `QQBot ${accessToken}`,
      };

      try {
        const FormData = require('form-data');
        formData = new FormData();
        formData.append('file', buffer, {
          filename: finalName || 'file',
          contentType: mime,
        });
        headers = { ...headers, ...formData.getHeaders() };
      } catch {
        // 如果form-data不可用，手动构建multipart/form-data
        const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
        const CRLF = '\r\n';
        let body = '';
        body += `--${boundary}${CRLF}`;
        body += `Content-Disposition: form-data; name="file"; filename="${finalName || 'file'}"${CRLF}`;
        body += `Content-Type: ${mime}${CRLF}`;
        body += CRLF;
        const bodyBuffer = Buffer.concat([
          Buffer.from(body, 'utf8'),
          buffer,
          Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'),
        ]);
        formData = bodyBuffer;
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        headers['Content-Length'] = String(bodyBuffer.length);
      }

      const uploadUrl = this.buildFileEndpoint(chatId);
      const uploadRes = await axios.post(uploadUrl, formData, {
        headers,
        timeout: 120000,
        validateStatus: () => true,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      if (uploadRes.status === 200 && uploadRes.data?.url) {
        const endpoint = this.buildMessageEndpoint(chatId);
        bridgeLogger.info(`[QQ] sendFileAttachment endpoint: ${endpoint}`);
        const messageRes = await this.makeRequest<{ id: string; msg_id: string }>(
          'POST',
          endpoint,
          {
            media: {
              file_info: uploadRes.data.url,
            },
            msg_type: 2, // 图片消息
          },
        );
        return messageRes.code === 0;
      }

      return false;
    } catch (e) {
      bridgeLogger.error('[QQ] ❌ Upload file failed:', e);
      return false;
    }
  }

  private async buildFilePart(
    messageId: string,
    attachment: {
      id: string;
      url: string;
      filename?: string;
      content_type?: string;
      size?: number;
    },
    chatId: string,
  ): Promise<FilePartInput | null> {
    let progressMsgId: string | null = null;
    const progressMap: Map<string, string> =
      globalState.__bridge_progress_msg_ids || new Map<string, string>();
    globalState.__bridge_progress_msg_ids = progressMap;

    const progressKey = messageId;
    try {
      bridgeLogger.info(
        `[QQ] 📦 Download resource start: msg=${messageId} url=${attachment.url} name=${attachment.filename || ''}`,
      );
      const maxSizeMb =
        globalState.__bridge_max_file_size?.get(chatId) ?? DEFAULT_MAX_FILE_MB;
      const maxBytes = Math.floor(maxSizeMb * 1024 * 1024);

      const maxRetry =
        globalState.__bridge_max_file_retry?.get(chatId) ?? DEFAULT_MAX_FILE_RETRY;

      if (maxRetry > 0) {
        progressMsgId = await this.sendMessage(
          chatId,
          `⏳ 正在处理文件：${attachment.filename || 'file'}`,
        );
        if (progressMsgId) {
          progressMap.set(progressKey, progressMsgId);
        }
      }

      let res: { buffer: Buffer; mime?: string } | null = null;

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          res = await this.fetchUrlToBuffer(attachment.url, maxBytes);
          break;
        } catch (e) {
          if (attempt >= maxRetry) throw e;
          await sleep(500 * (attempt + 1));
        }
      }

      if (!res) return null;

      const buf = res.buffer;

      if (buf.length > maxBytes) {
        await this.sendMessage(
          chatId,
          `❌ 文件过大（${(buf.length / 1024 / 1024).toFixed(2)}MB），当前限制 ${maxSizeMb}MB。`,
        );
        bridgeLogger.warn(`[QQ] ⚠️ Resource too large: ${buf.length} bytes > ${maxBytes}`);
        if (progressMsgId) {
          await this.editMessage(chatId, progressMsgId, '❌ 文件过大').catch(() => {});
          progressMap.delete(progressKey);
        }
        return null;
      }

      const mime = res.mime || attachment.content_type || 'application/octet-stream';
      const url = `data:${mime};base64,${buf.toString('base64')}`;

      bridgeLogger.info(`[QQ] ✅ Download resource ok: size=${buf.length} bytes mime=${mime}`);

      return {
        type: 'file',
        mime,
        filename: attachment.filename || 'file',
        url,
      };
    } catch (e) {
      bridgeLogger.error('[QQ] ❌ Failed to download resource:', {
        messageId,
        url: attachment.url,
        filename: attachment.filename,
        error: e,
      });
      if (progressMsgId) {
        await this.editMessage(chatId, progressMsgId, '❌ 文件下载失败，请重试。').catch(() => {});
        progressMap.delete(progressKey);
      }
      const sendError = globalState.__bridge_send_error_message;
      if (sendError) {
        await sendError(chatId, '资源下载失败，请稍后重试。');
      } else {
        await this.sendMessage(chatId, `${ERROR_HEADER}\n资源下载失败，请稍后重试。`);
      }
      return null;
    }
  }

  async startWebSocket(onMessage: IncomingMessageHandler) {
    if (globalState.__qq_ws_client_instance) return;

    // QQ WebSocket实现需要ws库，暂时先记录日志
    bridgeLogger.warn('[QQ] WebSocket mode not fully implemented yet, please use webhook mode');
    // TODO: 实现QQ WebSocket连接
    // 需要使用ws库: const WebSocket = require('ws');
    // const wsUrl = `wss://api.sgroup.qq.com/websocket`;
    // this.wsClient = new WebSocket(wsUrl);
    // ... 实现WebSocket逻辑
  }

  async startWebhook(onMessage: IncomingMessageHandler) {
    if (this.httpServer) return;

    const port = this.callbackPort || 8080;
    this.httpServer = http.createServer((req, res) => {
      bridgeLogger.info(`[QQ] Received webhook request: ${req.method} ${req.url}`);
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

          let body: Record<string, unknown> = {};
          const parsed = JSON.parse(rawBody);
          if (!isRecord(parsed)) {
            res.writeHead(400);
            res.end();
            return;
          }
          body = parsed;

          const encrypted = typeof body.encrypt === 'string' ? body.encrypt : '';
          if (encrypted && this.config.encrypt_key) {
            const decrypted = decryptEvent(encrypted, this.config.encrypt_key);
            const decryptedBody = JSON.parse(decrypted);
            if (!isRecord(decryptedBody)) {
              res.writeHead(400);
              res.end();
              return;
            }
            body = decryptedBody;
          }

          // QQ回调地址验证：type=1 表示验证请求
          if (body.op === 13) {
            bridgeLogger.info('[QQ] 📋 Received callback validation request');
            
            // 解析验证请求数据
            let validationData: Record<string, unknown> = {};
            if (body.d) {
              if (typeof body.d === 'string') {
                try {
                  validationData = JSON.parse(body.d);
                } catch {
                  bridgeLogger.error('[QQ] Failed to parse validation data');
                  res.writeHead(400);
                  res.end();
                  return;
                }
              } else if (isRecord(body.d)) {
                validationData = body.d;
              }
            }
            
            const plainToken = typeof validationData.plain_token === 'string' 
              ? validationData.plain_token 
              : '';
            const eventTs = typeof validationData.event_ts === 'string' 
              ? validationData.event_ts 
              : '';
            
            if (!plainToken || !eventTs) {
              bridgeLogger.error('[QQ] Missing plain_token or event_ts in validation request');
              res.writeHead(400);
              res.end();
              return;
            }
            
            // 使用botSecret进行签名验证
            if (!this.config.secret) {
              bridgeLogger.error('[QQ] Missing secret in config, cannot validate callback');
              res.writeHead(500);
              res.end();
              return;
            }
            
            try {
              const signature = validateQQCallbackEd25519(plainToken, eventTs, this.config.secret);
              
              const response = {
                plain_token: plainToken,
                signature: signature,
              };
              
              bridgeLogger.info('[QQ] ✅ Callback validation successful');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
              return;
            } catch (e) {
              bridgeLogger.error('[QQ] ❌ Callback validation failed:', e);
              res.writeHead(500);
              res.end();
              return;
            }
          }

          bridgeLogger.info(`body: ${JSON.stringify(body)}`);
          if (body.op === 0 && isRecord(body.d)) {
            const eventType = body.t as string;
            bridgeLogger.info(`eventType: ${eventType}`);
            // QQ官方机器人事件类型：C2C_MESSAGE_CREATE（私聊）或 GROUP_AT_MESSAGE_CREATE（群聊@消息）
            if (eventType === 'C2C_MESSAGE_CREATE' || eventType === 'GROUP_AT_MESSAGE_CREATE') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 0 }));

              const msg = body.d as unknown as QQMessage;
              bridgeLogger.info(`msg: ${JSON.stringify(msg)}`);
              if (msg.id && !this.isMessageProcessed(msg.id)) {
                // 根据chat_type构建chatId
                const chatId = eventType === 'GROUP_AT_MESSAGE_CREATE' 
                  ? `group_${msg.group_openid || ''}` 
                  : `c2c_${msg.author.user_openid || ''}`;
                const messageId = msg.id;
                const senderId = msg.chat_type === 'group' 
                  ? msg.author?.member_openid || '' 
                  : msg.author?.user_openid || '';
                const content = msg.content || '';

                if (content) {
                  bridgeLogger.info(
                    `[QQ] 📥 webhook text chat=${chatId} msg=${messageId} sender=${senderId} type=${msg.chat_type} len=${content.length}`,
                  );
                  onMessage(chatId, content, messageId, senderId).catch(err => {
                    bridgeLogger.error('[QQ Webhook] ❌ Handler Error:', err);
                  });
                }

                if (msg.attachments && msg.attachments.length > 0) {
                  for (const att of msg.attachments) {
                    if (att.url) {
                      const part = await this.buildFilePart(messageId, {
                        id: messageId,
                        url: att.url,
                        filename: att.filename,
                        content_type: att.content_type,
                        size: att.size,
                      }, chatId);
                      if (part) {
                        bridgeLogger.info(
                          `[QQ] 📥 webhook file chat=${chatId} msg=${messageId} sender=${senderId} name=${part.filename || ''} mime=${part.mime || ''}`,
                        );
                        onMessage(chatId, '', messageId, senderId, [part]).catch(err => {
                          bridgeLogger.error('[QQ Webhook] ❌ Handler Error:', err);
                        });
                      }
                    }
                  }
                }
              }
              return;
            }
          }

          res.writeHead(200);
          res.end('OK');
        } catch (e) {
          bridgeLogger.error('[QQ Webhook] ❌ Server Error:', e);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      bridgeLogger.info(`✅ QQ Webhook Server listening on port ${port}`);
      if (this.callbackUrl) {
        bridgeLogger.info(`[QQ] Callback URL: ${this.callbackUrl}`);
      } else {
        bridgeLogger.info('[QQ] Callback URL: http://<public-host>:' + port);
      }
    });
  }

  async stop() {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
      globalState.__qq_ws_client_instance = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}
