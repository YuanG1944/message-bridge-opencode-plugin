// src/feishu/feishuClient.ts
import * as lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import * as https from 'https';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { FeishuConfig, IncomingMessageHandler } from '../types';
import type { FilePartInput } from '@opencode-ai/sdk';
import { bridgeLogger } from '../logger';
import {
  DEFAULT_MAX_FILE_MB,
  DEFAULT_MAX_FILE_RETRY,
  ERROR_HEADER,
  globalState,
  sleep,
} from '../utils';
import { FeishuRenderer } from './feishu.renderer';
import {
  fetchFeishuResourceToBuffer,
  uploadFeishuFileBuffer,
  uploadFeishuImageBuffer,
} from './patch';
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { BRIDGE_FEISHU_RESPONSE_TIMEOUT_MS } from '../constants';
import { sanitizeTemplateMarkers } from '../utils';

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
    if (!obj || typeof obj !== 'object') return false;
    const record = obj as Record<string, unknown>;
    return Array.isArray(record.elements) || typeof record.card_link === 'string';
  } catch {
    return false;
  }
}

const FEISHU_RESPONSE_TIMEOUT_MS = (() => {
  const raw = Number(BRIDGE_FEISHU_RESPONSE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : BRIDGE_FEISHU_RESPONSE_TIMEOUT_MS;
})();

function isUnresolvedVariableError(payload: unknown): boolean {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null) continue;

    if (typeof cur === 'string') {
      if (
        /unresolved variable|card contains unresolved variable|errcode:\s*201008|201008/i.test(cur)
      ) {
        return true;
      }
      continue;
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }

    if (typeof cur === 'object') {
      const rec = cur as Record<string, unknown>;
      const code = rec.code;
      if (code === 230099) return true;

      for (const v of Object.values(rec)) stack.push(v);
      continue;
    }
  }

  return false;
}

type MentionLike = { key?: string };
type TenantTokenResponse = {
  token?: string;
  expiresIn?: number;
};

type TenantRequestOptions = ReturnType<typeof lark.withTenantToken>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function parseTenantTokenResponse(res: unknown): TenantTokenResponse {
  const top = isRecord(res) ? res : undefined;
  const data = top ? getNestedRecord(top, 'data') : undefined;

  const tokenRaw = data?.tenant_access_token ?? top?.tenant_access_token;
  const token = typeof tokenRaw === 'string' ? tokenRaw : undefined;

  const expiresRaw =
    data?.expire ??
    data?.expires_in ??
    data?.expire_in ??
    top?.expire ??
    top?.expires_in ??
    top?.expire_in;

  const expiresIn = expiresRaw != null ? Number(expiresRaw) : undefined;
  return { token, expiresIn: Number.isFinite(expiresIn) ? expiresIn : undefined };
}

function getMessageType(value: unknown): string {
  if (!isRecord(value)) return 'text';
  const msgType = value.msg_type;
  if (typeof msgType === 'string' && msgType) return msgType;
  const messageType = value.message_type;
  if (typeof messageType === 'string' && messageType) return messageType;
  return 'text';
}

const processedMessageIds: Set<string> =
  globalState.__feishu_processed_ids || new Set<string>();
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
  private renderer: FeishuRenderer;
  private tenantToken?: string;
  private tenantTokenExpiresAt?: number;
  private refreshTenantTokenPromise?: Promise<string>;

  constructor(config: FeishuConfig) {
    this.config = config;
    const httpAgent = new http.Agent({ keepAlive: true });
    const httpsAgent = new https.Agent({ keepAlive: true });
    const httpInstance = lark.defaultHttpInstance;
    httpInstance.defaults.timeout = 120000;
    httpInstance.defaults.httpAgent = httpAgent;
    httpInstance.defaults.httpsAgent = httpsAgent;

    this.apiClient = new lark.Client({
      appId: config.app_id,
      appSecret: config.app_secret,
      httpInstance,
      loggerLevel: LoggerLevel.info,
    });

    this.renderer = new FeishuRenderer();
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
      bridgeLogger.info(`[Feishu] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value || '';
      processedMessageIds.delete(first);
    }
    return false;
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

  private inferMimeFromFilename(filename?: string): string | undefined {
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
      case '.bmp':
        return 'image/bmp';
      case '.tiff':
      case '.tif':
        return 'image/tiff';
      case '.ico':
        return 'image/x-icon';
      case '.pdf':
        return 'application/pdf';
      case '.doc':
        return 'application/msword';
      case '.docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case '.xls':
        return 'application/vnd.ms-excel';
      case '.xlsx':
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case '.ppt':
        return 'application/vnd.ms-powerpoint';
      case '.pptx':
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case '.mp4':
        return 'video/mp4';
      case '.opus':
        return 'audio/opus';
      default:
        return undefined;
    }
  }

  private filenameFromContentDisposition(disposition?: string): string | undefined {
    if (!disposition) return undefined;
    const match = disposition.match(/filename\\*=UTF-8''([^;]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]);
    const match2 = disposition.match(/filename=\"?([^\";]+)\"?/i);
    return match2?.[1];
  }

  private async fetchUrlToBuffer(
    urlStr: string,
    maxBytes: number,
    redirectLeft = 3,
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
      this.filenameFromContentDisposition(res.headers?.['content-disposition'] as string) ||
      path.basename(url.pathname) ||
      undefined;
    return { buffer, mime, filename };
  }

  private async getTenantToken(): Promise<string> {
    if (!this.tenantToken || this.isTenantTokenExpired()) {
      await this.refreshTenantToken();
    }
    if (!this.tenantToken) {
      throw new Error('[Feishu] Missing tenant_access_token');
    }
    return this.tenantToken;
  }

  private inferFileType(
    mime: string,
    filename?: string,
  ): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const m = (mime || '').toLowerCase();
    if (m.includes('audio/opus')) return 'opus';
    if (m.includes('video/mp4')) return 'mp4';
    if (m.includes('application/pdf')) return 'pdf';
    if (m.includes('application/msword') || m.includes('wordprocessingml')) return 'doc';
    if (m.includes('application/vnd.ms-excel') || m.includes('spreadsheetml')) return 'xls';
    if (m.includes('application/vnd.ms-powerpoint') || m.includes('presentationml')) return 'ppt';

    const ext = filename ? path.extname(filename).toLowerCase() : '';
    if (ext === '.opus') return 'opus';
    if (ext === '.mp4') return 'mp4';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.doc' || ext === '.docx') return 'doc';
    if (ext === '.xls' || ext === '.xlsx') return 'xls';
    if (ext === '.ppt' || ext === '.pptx') return 'ppt';
    return 'stream';
  }

  private async sendMediaMessage(
    chatId: string,
    msgType: 'image' | 'file',
    content: Record<string, string>,
  ): Promise<boolean> {
    try {
      bridgeLogger.info(
        `[Feishu] 📤 sendMediaMessage type=${msgType} chat=${chatId} content=${JSON.stringify(
          content,
        )}`,
      );
      const res = await this.runWithTenantRetry(options =>
        this.apiClient.im.message.create(
          {
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: msgType,
              content: JSON.stringify(content),
            },
          },
          options,
        ),
      );
      return res.code === 0;
    } catch (e) {
      bridgeLogger.error('[Feishu] ❌ Failed to send media:', e);
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
      `[Feishu] 📎 sendFileAttachment url=${url.slice(0, 120)}${
        url.length > 120 ? '...' : ''
      } filename=${filename || ''} mime=${file.mime || ''}`,
    );
    bridgeLogger.info(
      `[Feishu] 🌐 proxy http_proxy=${process.env.http_proxy || ''} https_proxy=${
        process.env.https_proxy || ''
      } NO_PROXY=${process.env.NO_PROXY || process.env.no_proxy || ''}`,
    );

    let buffer: Buffer | null = null;
    let mime = file.mime || '';
    let finalName = filename || '';

    if (url.startsWith('data:')) {
      const decoded = this.decodeDataUrl(url);
      if (!decoded) {
        bridgeLogger.warn('[Feishu] ⚠️ Skip file: invalid data URL.');
        return false;
      }
      buffer = decoded.buffer;
      if (!mime) mime = decoded.mime;
      bridgeLogger.info(`[Feishu] ✅ data URL decoded size=${buffer.length} mime=${mime}`);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      const maxBytes = mime.startsWith('image/') ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
      try {
        bridgeLogger.info(`[Feishu] ⬇️ downloading url (max=${maxBytes} bytes)`);
        const res = await this.fetchUrlToBuffer(url, maxBytes);
        buffer = res.buffer;
        if (!mime) mime = res.mime || '';
        if (!finalName) finalName = res.filename || '';
        bridgeLogger.info(
          `[Feishu] ✅ download ok size=${buffer.length} mime=${mime} filename=${finalName}`,
        );
      } catch (e) {
        bridgeLogger.error('[Feishu] ❌ Download file failed:', e);
        return false;
      }
    } else if (url.startsWith('file://') || path.isAbsolute(url)) {
      try {
        const absPath = url.startsWith('file://') ? fileURLToPath(url) : url;
        buffer = await fs.readFile(absPath);
        if (!finalName) finalName = path.basename(absPath);
        bridgeLogger.info(
          `[Feishu] ✅ local file loaded size=${buffer.length} path=${absPath} filename=${finalName}`,
        );
      } catch (e) {
        bridgeLogger.error('[Feishu] ❌ Read local file failed:', e);
        return false;
      }
    } else {
      bridgeLogger.warn('[Feishu] ⚠️ Skip file: unsupported URL scheme.');
      return false;
    }

    if (!buffer) return false;
    if (!mime) mime = this.inferMimeFromFilename(finalName) || 'application/octet-stream';

    if (mime.startsWith('image/')) {
      if (buffer.length > 10 * 1024 * 1024) {
        bridgeLogger.warn('[Feishu] ⚠️ Image too large (>10MB).');
        return false;
      }
      try {
        bridgeLogger.info(
          `[Feishu] ⬆️ uploading image size=${buffer.length} mime=${mime} name=${finalName}`,
        );
        const imageKey = await this.runWithTenantRetry(async () => {
          const tenantToken = await this.getTenantToken();
          return uploadFeishuImageBuffer({
            tenantToken,
            buffer,
            filename: finalName || 'image',
            timeoutMs: 120000,
          });
        });
        bridgeLogger.info(`[Feishu] ✅ upload image ok image_key=${imageKey || ''}`);
        if (!imageKey) return false;
        return this.sendMediaMessage(chatId, 'image', { image_key: imageKey });
      } catch (e) {
        bridgeLogger.error('[Feishu] ❌ Upload image failed:', e);
        return false;
      }
    }

    if (buffer.length > 30 * 1024 * 1024) {
      bridgeLogger.warn('[Feishu] ⚠️ File too large (>30MB).');
      return false;
    }

    try {
      const fileType = this.inferFileType(mime, finalName);
      bridgeLogger.info(
        `[Feishu] ⬆️ uploading file size=${buffer.length} mime=${mime} type=${fileType} name=${finalName}`,
      );
      const fileKey = await this.runWithTenantRetry(async () => {
        const tenantToken = await this.getTenantToken();
        return uploadFeishuFileBuffer({
          tenantToken,
          buffer,
          filename: finalName || 'file',
          fileType,
          timeoutMs: 120000,
        });
      });
      bridgeLogger.info(`[Feishu] ✅ upload file ok file_key=${fileKey || ''}`);
      if (!fileKey) return false;
      return this.sendMediaMessage(chatId, 'file', { file_key: fileKey });
    } catch (e) {
      bridgeLogger.error('[Feishu] ❌ Upload file failed:', e);
      return false;
    }
  }

  private parseAndCleanContent(contentJson: string, mentions?: MentionLike[]): string {
    try {
      const parsed = JSON.parse(contentJson);
      const content = isRecord(parsed) ? parsed : {};
      let text = typeof content.text === 'string' ? content.text : '';
      if (mentions && mentions.length > 0) {
        mentions.forEach(m => {
          if (m.key) {
            const regex = new RegExp(m.key, 'g');
            text = text.replace(regex, '');
          }
        });
      }
      return text.trim();
    } catch (e: unknown) {
      bridgeLogger.error(`[Feishu] ❌ Content Parse Error!`, e);
      return '';
    }
  }

  private isTenantTokenExpired(): boolean {
    if (!this.tenantTokenExpiresAt) return false;
    return Date.now() >= this.tenantTokenExpiresAt - 60 * 1000 - 1000;
  }

  private async refreshTenantToken(): Promise<string> {
    if (this.refreshTenantTokenPromise) return this.refreshTenantTokenPromise;
    this.refreshTenantTokenPromise = (async () => {
      const res = await this.apiClient.auth.tenantAccessToken.internal({
        data: {
          app_id: this.config.app_id,
          app_secret: this.config.app_secret,
        },
      });
      const { token, expiresIn } = parseTenantTokenResponse(res);
      if (!token) {
        this.refreshTenantTokenPromise = undefined;
        throw new Error(`[Feishu] Failed to refresh tenant token: ${JSON.stringify(res)}`);
      }
      this.tenantToken = token;
      const expiresSec = expiresIn ?? 0;
      if (expiresSec > 0) {
        this.tenantTokenExpiresAt = Date.now() + expiresSec * 1000;
      } else {
        this.tenantTokenExpiresAt = undefined;
      }
      this.refreshTenantTokenPromise = undefined;
      return token;
    })();
    return this.refreshTenantTokenPromise;
  }

  private shouldRefreshTenantToken(error: unknown): boolean {
    const top = isRecord(error) ? error : {};
    const response = getNestedRecord(top, 'response');
    const data = (response && getNestedRecord(response, 'data')) || getNestedRecord(top, 'data');
    const code = typeof data?.code === 'number' ? data.code : undefined;
    const msg = String(data?.msg || data?.message || getErrorMessage(error) || '');
    if (code !== undefined && [99991663, 99991664, 99991665, 99991671, 99991672, 99991673].includes(code)) {
      return true;
    }
    if (
      /tenant_access_token|access token|token invalid|invalid token|token expired|expire/i.test(msg)
    ) {
      return true;
    }
    if (response?.status === 401) return true;
    return false;
  }

  private async requestOptions(): Promise<TenantRequestOptions | undefined> {
    if (!this.tenantToken || this.isTenantTokenExpired()) {
      await this.refreshTenantToken();
    }
    return this.tenantToken ? lark.withTenantToken(this.tenantToken) : undefined;
  }

  private async runWithTenantRetry<T>(
    fn: (options?: TenantRequestOptions) => Promise<T>,
  ): Promise<T> {
    const options = await this.requestOptions();
    try {
      return await fn(options);
    } catch (e) {
      if (!this.shouldRefreshTenantToken(e)) throw e;
      bridgeLogger.warn('[Feishu] 🔄 tenant_access_token expired, refreshing...');
      await this.refreshTenantToken();
      bridgeLogger.info('[Feishu] ✅ tenant_access_token refreshed.');
      const retryOptions = this.tenantToken ? lark.withTenantToken(this.tenantToken) : undefined;
      return await fn(retryOptions);
    }
  }

  private async buildFilePart(
    messageId: string,
    msgType: string,
    contentJson: string,
    chatId: string,
  ): Promise<FilePartInput | null> {
    let content: Record<string, unknown>;

    bridgeLogger.info('buildFilePart prams', { messageId, msgType, contentJson, chatId });

    try {
      const parsed = JSON.parse(contentJson);
      if (!isRecord(parsed)) return null;
      content = parsed;
    } catch {
      return null;
    }

    const fileKeyRaw = content.file_key || content.image_key || content.fileKey || content.imageKey;
    const fileKey = typeof fileKeyRaw === 'string' ? fileKeyRaw : '';
    if (!fileKey) return null;

    const fileNameRaw = content.file_name || content.name || content.fileName;
    const fileName =
      typeof fileNameRaw === 'string' && fileNameRaw ? fileNameRaw : `${msgType}-${fileKey}`;

    let progressMsgId: string | null = null;
    const progressMap: Map<string, string> =
      globalState.__bridge_progress_msg_ids || new Map<string, string>();
    globalState.__bridge_progress_msg_ids = progressMap;

    const progressKey = messageId;
    try {
      bridgeLogger.info(
        `[Feishu] 📦 Download resource start: msg=${messageId} type=${msgType} key=${fileKey} name=${fileName}`,
      );
      const maxSizeMb =
        globalState.__bridge_max_file_size?.get(chatId) ?? DEFAULT_MAX_FILE_MB;
      const maxBytes = Math.floor(maxSizeMb * 1024 * 1024);

      let res: {
        buffer: Buffer;
        mime?: string;
        headers?: Record<string, unknown>;
      } | null = null;
      const maxRetry =
        globalState.__bridge_max_file_retry?.get(chatId) ?? DEFAULT_MAX_FILE_RETRY;

      if (maxRetry > 0) {
        progressMsgId = await this.sendMessage(
          chatId,
          this.renderer.render(`## Status\n⏳ 正在处理 ${msgType} 文件：${fileName}`),
        );
        if (progressMsgId) {
          progressMap.set(progressKey, progressMsgId);
        }
      }

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          res = await this.runWithTenantRetry(async () => {
            const tenantToken = await this.getTenantToken();
            return fetchFeishuResourceToBuffer({
              messageId,
              fileKey,
              msgType,
              maxBytes,
              tenantToken,
              timeoutMs: 120000,
            });
          });
          break;
        } catch (e) {
          if (attempt >= maxRetry) throw e;
          await sleep(500 * (attempt + 1));
        }
      }

      if (!res) return null;

      const contentLengthRaw = res.headers?.['content-length'];
      const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;

      if (contentLength && contentLength > maxBytes) {
        await this.sendMessage(
          chatId,
          `❌ 文件过大（${(contentLength / 1024 / 1024).toFixed(
            2,
          )}MB），当前限制 ${maxSizeMb}MB。可用 /maxFileSize <xmb> 调整。`,
        );
        bridgeLogger.warn(
          `[Feishu] ⚠️ Resource too large by header: ${contentLength} bytes > ${maxBytes}`,
        );
        if (progressMsgId) {
          await this.editMessage(
            chatId,
            progressMsgId,
            this.renderer.render(
              `## Status\n❌ 文件过大（${(contentLength / 1024 / 1024).toFixed(
                2,
              )}MB），当前限制 ${maxSizeMb}MB。`,
            ),
          ).catch(() => {});
          progressMap.delete(progressKey);
        }
        return null;
      }

      const buf = res.buffer;

      if (buf.length > maxBytes) {
        await this.sendMessage(
          chatId,
          `❌ 文件过大（${(buf.length / 1024 / 1024).toFixed(
            2,
          )}MB），当前限制 ${maxSizeMb}MB。可用 /maxFileSize <xmb> 调整。`,
        );
        bridgeLogger.warn(`[Feishu] ⚠️ Resource too large by body: ${buf.length} bytes > ${maxBytes}`);
        if (progressMsgId) {
          await this.editMessage(
            chatId,
            progressMsgId,
            this.renderer.render(
              `## Status\n❌ 文件过大（${(buf.length / 1024 / 1024).toFixed(
                2,
              )}MB），当前限制 ${maxSizeMb}MB。`,
            ),
          ).catch(() => {});
          progressMap.delete(progressKey);
        }
        return null;
      }

      const mime =
        res.mime || (res.headers?.['content-type'] as string) || 'application/octet-stream';
      const url = `data:${mime};base64,${buf.toString('base64')}`;

      bridgeLogger.info(`[Feishu] ✅ Download resource ok: size=${buf.length} bytes mime=${mime}`);

      return {
        type: 'file',
        mime,
        filename: fileName,
        url,
      };
    } catch (e) {
      bridgeLogger.error('[Feishu] ❌ Failed to download resource:', {
        messageId,
        msgType,
        fileKey,
        fileName,
        error: e,
      });
      if (progressMsgId) {
        await this.editMessage(
          chatId,
          progressMsgId,
          this.renderer.render('## Status\n❌ 文件上传失败，请重试。'),
        ).catch(() => {});
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
          text: { tag: 'lark_md', content: sanitizeTemplateMarkers(raw) },
        },
      ],
    });
  }

  private extractPlainTextForFallback(input: string): string {
    const raw = (input || '').trim();
    if (!raw) return 'Message';

    const chunks: string[] = [];

    const walk = (node: unknown) => {
      if (node == null) return;
      if (typeof node === 'string') {
        const s = node.trim();
        if (s) chunks.push(s);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node === 'object') {
        const rec = node as Record<string, unknown>;
        for (const [k, v] of Object.entries(rec)) {
          if (k === 'content' && typeof v === 'string') {
            const s = v.trim();
            if (s) chunks.push(s);
            continue;
          }
          walk(v);
        }
      }
    };

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        walk(JSON.parse(raw));
      } catch {
        // ignore parse error and fallback to raw text
      }
    }

    if (chunks.length === 0) return raw;

    const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return text || raw;
  }

  private async sendTextMessage(chatId: string, text: string): Promise<string | null> {
    const fallbackText = this.extractPlainTextForFallback(text);
    try {
      const res = await this.withResponseTimeout(
        this.runWithTenantRetry(options =>
          this.apiClient.im.message.create(
            {
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: fallbackText }),
              },
            },
            options,
          ),
        ),
        'sendMessage(text-fallback)',
      );
      if (res.code === 0 && res.data?.message_id) return res.data.message_id;
      bridgeLogger.error('[Feishu] ❌ Text fallback send failed:', res);
      return null;
    } catch (e) {
      bridgeLogger.error('[Feishu] ❌ Text fallback send failed:', e);
      return null;
    }
  }

  private async patchTextMessage(messageId: string, text: string): Promise<boolean> {
    const fallbackText = this.extractPlainTextForFallback(text);
    try {
      const res = await this.withResponseTimeout(
        this.runWithTenantRetry(options =>
          this.apiClient.im.message.patch(
            {
              path: { message_id: messageId },
              data: {
                content: JSON.stringify({ text: fallbackText }),
              },
            },
            options,
          ),
        ),
        'editMessage(text-fallback)',
      );
      return res.code === 0;
    } catch {
      return false;
    }
  }

  private async withResponseTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`[Feishu] ${label} timeout after ${FEISHU_RESPONSE_TIMEOUT_MS}ms`));
          }, FEISHU_RESPONSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    try {
      const isCard = looksLikeJsonCard(text);

      const finalContent = isCard ? text : this.makeCard(text);

      const res = await this.withResponseTimeout(
        this.runWithTenantRetry(options =>
          this.apiClient.im.message.create(
            {
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive', // 永远使用 interactive
                content: finalContent,
              },
            },
            options,
          ),
        ),
        'sendMessage(interactive)',
      );
      if (res.code === 0 && res.data?.message_id) return res.data.message_id;
      if (isUnresolvedVariableError(res)) {
        bridgeLogger.warn(
          '[Feishu] ⚠️ Card contains unresolved variable (201008), fallback to text message',
        );
        return await this.sendTextMessage(chatId, text);
      }
      bridgeLogger.error('[Feishu] ❌ Send failed:', res);
      return null;
    } catch (e) {
      if (isUnresolvedVariableError(e)) {
        bridgeLogger.warn(
          '[Feishu] ⚠️ Card contains unresolved variable (201008), fallback to text message',
        );
        return await this.sendTextMessage(chatId, text);
      }
      bridgeLogger.error('[Feishu] ❌ Failed to send:', e);
      return null;
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const res = await this.withResponseTimeout(
        this.runWithTenantRetry(options =>
          this.apiClient.im.message.patch(
            {
              path: { message_id: messageId },
              data: {
                content: text,
              },
            },
            options,
          ),
        ),
        'editMessage(interactive)',
      );

      if (res.code !== 0 && isUnresolvedVariableError(res)) {
        bridgeLogger.warn(
          `[Feishu] ⚠️ Card edit unresolved variable (201008), fallback to text patch msg=${messageId}`,
        );
        return await this.patchTextMessage(messageId, text);
      }

      return res.code === 0;
    } catch (e) {
      if (isUnresolvedVariableError(e)) {
        bridgeLogger.warn(
          `[Feishu] ⚠️ Card edit unresolved variable (201008), fallback to text patch msg=${messageId}`,
        );
        return await this.patchTextMessage(messageId, text);
      }
      bridgeLogger.warn(
        `[Feishu] ⚠️ editMessage failed: msg=${messageId} reason=${getErrorMessage(e) || 'unknown'}`,
      );
      return false;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.runWithTenantRetry(options =>
        this.apiClient.im.messageReaction.create(
          {
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: emojiType } },
          },
          options,
        ),
      );
      return res.data?.reaction_id || null;
    } catch {
      return null;
    }
  }

  async removeReaction(messageId: string, reactionId: string) {
    if (!reactionId) return;
    try {
      await this.runWithTenantRetry(options =>
        this.apiClient.im.messageReaction.delete(
          {
            path: { message_id: messageId, reaction_id: reactionId },
          },
          options,
        ),
      );
    } catch {
      // ignore
    }
  }

  async startWebSocket(onMessage: IncomingMessageHandler) {
    if (globalState.__feishu_ws_client_instance) return;

    this.wsClient = new lark.WSClient({
      appId: this.config.app_id,
      appSecret: this.config.app_secret,
      loggerLevel: lark.LoggerLevel.trace,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        bridgeLogger.info('.message.receive--->', data);
        const { message, sender } = data;
        const messageId = message.message_id;
        const chatId = message.chat_id;
        const senderId = sender?.sender_id?.open_id || '';

        if (this.isMessageProcessed(messageId)) return;

        const msgType = getMessageType(message);
        if (msgType === 'text') {
          const text = this.parseAndCleanContent(message.content, message.mentions);
          if (!text) return;
          bridgeLogger.info(
            `[Feishu] 📥 ws text chat=${chatId} msg=${messageId} sender=${senderId} len=${text.length}`,
          );
          await onMessage(chatId, text, messageId, senderId);
          return;
        }

        const part = await this.buildFilePart(messageId, msgType, message.content, chatId);
        if (!part) return;
        bridgeLogger.info(
          `[Feishu] 📥 ws file chat=${chatId} msg=${messageId} sender=${senderId} type=${msgType} name=${part.filename || ''} mime=${part.mime || ''}`,
        );
        await onMessage(chatId, '', messageId, senderId, [part]);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    globalState.__feishu_ws_client_instance = this.wsClient;
    bridgeLogger.info('✅ Feishu WebSocket Connected!');
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

          if (body.type === 'url_verification') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(
              JSON.stringify({
                challenge: typeof body.challenge === 'string' ? body.challenge : '',
              }),
            );
          }

          const header = getNestedRecord(body, 'header');
          if (header?.event_type === 'im.message.receive_v1') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            const event = getNestedRecord(body, 'event');
            const eventMessage = event ? getNestedRecord(event, 'message') : undefined;
            const eventSender = event ? getNestedRecord(event, 'sender') : undefined;
            const senderID = eventSender ? getNestedRecord(eventSender, 'sender_id') : undefined;
            const messageId =
              typeof eventMessage?.message_id === 'string' ? eventMessage.message_id : '';
            const chatId = typeof eventMessage?.chat_id === 'string' ? eventMessage.chat_id : '';
            const senderId = typeof senderID?.open_id === 'string' ? senderID.open_id : '';

            if (messageId && chatId && !this.isMessageProcessed(messageId)) {
              const msgType = getMessageType(eventMessage);
              const content =
                typeof eventMessage?.content === 'string' ? eventMessage.content : '{}';
              const mentions = Array.isArray(eventMessage?.mentions)
                ? (eventMessage.mentions as MentionLike[])
                : undefined;
              if (msgType === 'text') {
                const text = this.parseAndCleanContent(content, mentions);
                if (text) {
                  bridgeLogger.info(
                    `[Feishu] 📥 webhook text chat=${chatId} msg=${messageId} sender=${senderId} len=${text.length}`,
                  );
                  onMessage(chatId, text, messageId, senderId).catch(err => {
                    bridgeLogger.error('[Feishu Webhook] ❌ Handler Error:', err);
                  });
                }
              } else {
                const part = await this.buildFilePart(
                  messageId,
                  msgType,
                  content,
                  chatId,
                );
                if (!part) return;
                bridgeLogger.info(
                  `[Feishu] 📥 webhook file chat=${chatId} msg=${messageId} sender=${senderId} type=${msgType} name=${part.filename || ''} mime=${part.mime || ''}`,
                );
                onMessage(chatId, '', messageId, senderId, [part]).catch(err => {
                  bridgeLogger.error('[Feishu Webhook] ❌ Handler Error:', err);
                });
              }
            }
            return;
          }

          res.writeHead(200);
          res.end('OK');
        } catch (e) {
          bridgeLogger.error('[Feishu Webhook] ❌ Server Error:', e);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      bridgeLogger.info(`✅ Feishu Webhook Server listening on port ${port}`);
      if (this.callbackUrl) {
        bridgeLogger.info(`[Feishu] Callback URL: ${this.callbackUrl}`);
      } else {
        bridgeLogger.info('[Feishu] Callback URL: http://<public-host>:' + port);
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
