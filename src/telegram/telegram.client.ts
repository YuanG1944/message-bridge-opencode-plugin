import type { IncomingMessageHandler, TelegramConfig } from '../types';
import type { FilePartInput } from '@opencode-ai/sdk';
import * as http from 'node:http';
import { bridgeLogger } from '../logger';
import { runtimeInstanceId, sleep } from '../utils';

type TelegramUser = {
  id: number;
  is_bot?: boolean;
};

type TelegramChat = {
  id: number;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  video_note?: TelegramVideoNote;
  sticker?: TelegramSticker;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramPhotoSize = {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideo = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramAudio = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVoice = {
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramAnimation = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideoNote = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
};

type TelegramSticker = {
  file_id: string;
  file_unique_id?: string;
  is_animated?: boolean;
  is_video?: boolean;
  file_size?: number;
};

type TelegramFileInfo = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function clipTelegramText(text: string, limit = 3900): string {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n... (truncated, len=${text.length})`;
}

function stripTelegramHtml(html: string): string {
  return (html || '')
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, '$1')
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isParseEntityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /parse entities|can't parse entities/i.test(msg);
}

function isMessageNotModifiedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

function inferMimeFromFilename(filename?: string): string {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.ogg') || name.endsWith('.oga')) return 'audio/ogg';
  if (name.endsWith('.opus')) return 'audio/opus';
  if (name.endsWith('.tgs')) return 'application/x-tgsticker';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

export class TelegramClient {
  private readonly config: TelegramConfig;
  private readonly baseUrl: string;
  private running = false;
  private updateOffset = 0;
  private pollPromise: Promise<void> | null = null;
  private pollingAbortController: AbortController | null = null;
  private webhookServer: http.Server | null = null;
  private webhookPath = '/telegram/webhook';
  private readonly instanceTag = `pid=${process.pid} instance=${runtimeInstanceId}`;
  private readonly incomingMessageChatMap = new Map<string, string>();

  constructor(config: TelegramConfig) {
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.bot_token}`;
  }

  async start(handler: IncomingMessageHandler): Promise<void> {
    if (this.config.mode === 'webhook') {
      await this.startWebhook(handler);
      return;
    }
    await this.startPolling(handler);
  }

  async startPolling(handler: IncomingMessageHandler): Promise<void> {
    if (this.running) {
      bridgeLogger.info('[Telegram] polling already started');
      return;
    }

    await this.deleteWebhook(false).catch(() => {});
    this.running = true;
    this.pollingAbortController = new AbortController();
    this.pollPromise = this.pollLoop(handler);
    bridgeLogger.info(`[Telegram] polling started ${this.instanceTag}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.pollingAbortController?.abort();
    try {
      await this.pollPromise;
    } catch {}
    this.pollPromise = null;
    this.pollingAbortController = null;

    if (this.webhookServer) {
      await new Promise<void>((resolve, reject) => {
        this.webhookServer?.close(err => (err ? reject(err) : resolve()));
      }).catch(() => {});
      this.webhookServer = null;
      await this.deleteWebhook(false).catch(() => {});
      bridgeLogger.info('[Telegram] webhook stopped');
      return;
    }

    bridgeLogger.info('[Telegram] polling stopped');
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    const content = clipTelegramText(text);
    if (!content.trim()) return null;
    let res: TelegramMessage | null = null;
    try {
      res = await this.apiCall<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: content,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err) {
      if (!isParseEntityError(err)) throw err;
      bridgeLogger.warn('[Telegram] sendMessage parse_mode fallback to plain text');
      res = await this.apiCall<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: clipTelegramText(stripTelegramHtml(content)),
        disable_web_page_preview: true,
      });
    }
    return res ? String(res.message_id) : null;
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    const content = clipTelegramText(text);
    if (!content.trim()) return false;
    let res: TelegramMessage | null = null;
    try {
      res = await this.apiCall<TelegramMessage>('editMessageText', {
        chat_id: chatId,
        message_id: Number(messageId),
        text: content,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        return true;
      }
      if (!isParseEntityError(err)) throw err;
      bridgeLogger.warn('[Telegram] editMessage parse_mode fallback to plain text');
      try {
        res = await this.apiCall<TelegramMessage>('editMessageText', {
          chat_id: chatId,
          message_id: Number(messageId),
          text: clipTelegramText(stripTelegramHtml(content)),
          disable_web_page_preview: true,
        });
      } catch (plainErr) {
        if (isMessageNotModifiedError(plainErr)) {
          return true;
        }
        throw plainErr;
      }
    }
    return Boolean(res);
  }

  async sendTyping(chatId: string): Promise<boolean> {
    const res = await this.apiCall<boolean>('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    });
    return Boolean(res);
  }

  async setReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
    const res = await this.apiCall<boolean>('setMessageReaction', {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
      is_big: false,
    });
    return Boolean(res);
  }

  async clearReaction(chatId: string, messageId: string): Promise<boolean> {
    const res = await this.apiCall<boolean>('setMessageReaction', {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [],
      is_big: false,
    });
    return Boolean(res);
  }

  async setReactionByIncomingMessageId(messageId: string, emoji: string): Promise<boolean> {
    const chatId = this.incomingMessageChatMap.get(messageId);
    if (!chatId) return false;
    return this.setReaction(chatId, messageId, emoji);
  }

  async clearReactionByIncomingMessageId(messageId: string): Promise<boolean> {
    const chatId = this.incomingMessageChatMap.get(messageId);
    if (!chatId) return false;
    return this.clearReaction(chatId, messageId);
  }

  getChatIdByIncomingMessageId(messageId: string): string | null {
    return this.incomingMessageChatMap.get(messageId) || null;
  }

  private async getFileInfo(fileId: string): Promise<TelegramFileInfo | null> {
    const res = await this.apiCall<TelegramFileInfo>('getFile', { file_id: fileId });
    return res || null;
  }

  private async downloadFileByPath(filePath: string, maxBytes: number): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.config.bot_token}/${filePath}`;
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      throw new Error(`[Telegram] download failed: ${resp.status}`);
    }
    const arr = await resp.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.length > maxBytes) {
      throw new Error(`[Telegram] file too large: ${buf.length}`);
    }
    return buf;
  }

  private async buildFileParts(message: TelegramMessage): Promise<FilePartInput[]> {
    const parts: FilePartInput[] = [];
    const maxBytes = 20 * 1024 * 1024;

    const addByFileId = async (fileId: string, filename?: string, mime?: string) => {
      const info = await this.getFileInfo(fileId);
      const path = info?.file_path;
      if (!path) return;
      const buffer = await this.downloadFileByPath(path, maxBytes);
      const inferredMime = mime || inferMimeFromFilename(filename);
      parts.push({
        type: 'file',
        filename: filename || path.split('/').pop() || 'file',
        mime: inferredMime,
        url: `data:${inferredMime};base64,${buffer.toString('base64')}`,
      });
    };

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const sorted = [...message.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
      const largest = sorted[0];
      if (largest?.file_id) {
        await addByFileId(largest.file_id, `photo-${largest.file_unique_id || largest.file_id}.jpg`, 'image/jpeg');
      }
    }

    if (message.document?.file_id) {
      await addByFileId(
        message.document.file_id,
        message.document.file_name || `doc-${message.document.file_unique_id || message.document.file_id}`,
        message.document.mime_type || undefined,
      );
    }

    if (message.video?.file_id) {
      await addByFileId(
        message.video.file_id,
        message.video.file_name || `video-${message.video.file_unique_id || message.video.file_id}.mp4`,
        message.video.mime_type || 'video/mp4',
      );
    }

    if (message.audio?.file_id) {
      await addByFileId(
        message.audio.file_id,
        message.audio.file_name || `audio-${message.audio.file_unique_id || message.audio.file_id}.mp3`,
        message.audio.mime_type || 'audio/mpeg',
      );
    }

    if (message.voice?.file_id) {
      await addByFileId(
        message.voice.file_id,
        `voice-${message.voice.file_unique_id || message.voice.file_id}.ogg`,
        message.voice.mime_type || 'audio/ogg',
      );
    }

    if (message.animation?.file_id) {
      await addByFileId(
        message.animation.file_id,
        message.animation.file_name ||
          `animation-${message.animation.file_unique_id || message.animation.file_id}.gif`,
        message.animation.mime_type || 'image/gif',
      );
    }

    if (message.video_note?.file_id) {
      await addByFileId(
        message.video_note.file_id,
        `video-note-${message.video_note.file_unique_id || message.video_note.file_id}.mp4`,
        'video/mp4',
      );
    }

    if (message.sticker?.file_id) {
      const ext = message.sticker.is_video ? 'webm' : message.sticker.is_animated ? 'tgs' : 'webp';
      const mime = message.sticker.is_video
        ? 'video/webm'
        : message.sticker.is_animated
          ? 'application/x-tgsticker'
          : 'image/webp';
      await addByFileId(
        message.sticker.file_id,
        `sticker-${message.sticker.file_unique_id || message.sticker.file_id}.${ext}`,
        mime,
      );
    }

    return parts;
  }

  private async pollLoop(handler: IncomingMessageHandler): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        bridgeLogger.debug(`[Telegram] poll updates=${updates.length}`);
        if (updates.length > 0) {
          bridgeLogger.info(`[Telegram] received updates=${updates.length}`);
        }
        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          await this.handleUpdate(update, handler);
        }
      } catch (err) {
        const e = asError(err);
        if (e.name !== 'AbortError') {
          bridgeLogger.warn(`[Telegram] polling error ${this.instanceTag}`, e.message);
        }
      }

      if (!this.running) break;
      await sleep(this.config.polling_interval_ms);
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const res = await this.apiCall<TelegramUpdate[]>('getUpdates', {
      offset: this.updateOffset,
      timeout: this.config.polling_timeout_sec,
      allowed_updates: ['message'],
    }, this.pollingAbortController?.signal);
    return Array.isArray(res) ? res : [];
  }

  private async startWebhook(handler: IncomingMessageHandler): Promise<void> {
    if (this.running) {
      bridgeLogger.info('[Telegram] webhook already started');
      return;
    }
    if (!this.config.callback_url) {
      throw new Error('[Telegram] callback_url is required in webhook mode');
    }

    const callback = new URL(this.config.callback_url);
    this.webhookPath =
      callback.pathname && callback.pathname !== '/' ? callback.pathname : '/telegram/webhook';
    const port = callback.port ? Number(callback.port) : callback.protocol === 'https:' ? 443 : 80;
    const host = this.resolveWebhookHost(callback.hostname);

    this.webhookServer = http.createServer((req, res) => {
      this.handleWebhookRequest(req, res, handler).catch(err => {
        bridgeLogger.warn('[Telegram] webhook request failed', asError(err).message);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.webhookServer?.once('error', reject);
      this.webhookServer?.listen(port, host, () => resolve());
    });
    await this.setWebhook();

    this.running = true;
    bridgeLogger.info(
      `[Telegram] webhook started host=${host} port=${port} path=${this.webhookPath} ${this.instanceTag}`,
    );
  }

  private resolveWebhookHost(configHostname: string): string {
    const envHost = process.env.TELEGRAM_WEBHOOK_LISTEN_HOST?.trim();
    if (envHost) return envHost;
    if (
      configHostname === '0.0.0.0' ||
      configHostname === '127.0.0.1' ||
      configHostname === 'localhost'
    ) {
      return configHostname;
    }
    return '0.0.0.0';
  }

  private async handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: IncomingMessageHandler,
  ): Promise<void> {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const requestUrl = new URL(req.url, 'http://localhost');
    if (req.method !== 'POST' || requestUrl.pathname !== this.webhookPath) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (this.config.webhook_secret_token) {
      const token = req.headers['x-telegram-bot-api-secret-token'];
      const headerToken = Array.isArray(token) ? token[0] : token;
      if (headerToken !== this.config.webhook_secret_token) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false }));
        return;
      }
    }

    const raw = await this.readRequestBody(req, 2 * 1024 * 1024);
    let update: TelegramUpdate;
    try {
      update = JSON.parse(raw) as TelegramUpdate;
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));

    await this.handleUpdate(update, handler).catch(err => {
      bridgeLogger.warn('[Telegram] webhook update failed', asError(err).message);
    });
  }

  private async readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > maxBytes) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(b);
      });
      req.on('error', reject);
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  private async setWebhook(): Promise<void> {
    if (!this.config.callback_url) return;
    const payload: Record<string, unknown> = {
      url: this.config.callback_url,
      allowed_updates: ['message'],
    };
    if (this.config.webhook_secret_token) {
      payload.secret_token = this.config.webhook_secret_token;
    }
    await this.apiCall<boolean>('setWebhook', payload);
    bridgeLogger.info('[Telegram] setWebhook success');
  }

  private async deleteWebhook(dropPendingUpdates: boolean): Promise<void> {
    await this.apiCall<boolean>('deleteWebhook', {
      drop_pending_updates: dropPendingUpdates,
    });
    bridgeLogger.info('[Telegram] deleteWebhook success');
  }

  private async handleUpdate(
    update: TelegramUpdate,
    handler: IncomingMessageHandler,
  ): Promise<void> {
    const message = update.message;
    if (!message) {
      bridgeLogger.debug(`[Telegram] skip update_id=${update.update_id} reason=no_message`);
      return;
    }
    if (message.from?.is_bot) {
      bridgeLogger.debug(
        `[Telegram] skip update_id=${update.update_id} msg=${message.message_id} reason=from_bot`,
      );
      return;
    }

    const text = (message.text || message.caption || '').trim();
    let fileParts: FilePartInput[] = [];
    try {
      fileParts = await this.buildFileParts(message);
    } catch (err) {
      bridgeLogger.warn(
        `[Telegram] build file parts failed update_id=${update.update_id} msg=${message.message_id}`,
        err,
      );
    }
    if (!text && fileParts.length === 0) {
      bridgeLogger.debug(
        `[Telegram] skip update_id=${update.update_id} msg=${message.message_id} reason=no_text_or_file`,
      );
      return;
    }
    if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
      bridgeLogger.info(
        `[Telegram] skip update_id=${update.update_id} msg=${message.message_id} reason=tg_start`,
      );
      return;
    }

    const chatId = String(message.chat.id);
    const messageId = String(message.message_id);
    const senderId = String(message.from?.id ?? message.chat.id);
    this.incomingMessageChatMap.set(messageId, chatId);
    if (this.incomingMessageChatMap.size > 2000) {
      const first = this.incomingMessageChatMap.keys().next().value;
      if (first) this.incomingMessageChatMap.delete(first);
    }

    bridgeLogger.info(
      `[Telegram] incoming update_id=${update.update_id} chat=${chatId} sender=${senderId} msg=${messageId} textLen=${text.length} files=${fileParts.length}`,
    );
    await handler(chatId, text, messageId, senderId, fileParts);
  }

  private async apiCall<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const url = `${this.baseUrl}/${method}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });

    const json = (await resp.json()) as TelegramApiResponse<T>;
    if (!resp.ok || !json.ok) {
      throw new Error(`[Telegram] ${method} failed: ${json.description || resp.statusText}`);
    }
    return json.result ?? null;
  }
}
