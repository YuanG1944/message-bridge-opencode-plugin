// src/telegram/telegram.adapter.ts
import type {
  BridgeAdapter,
  IncomingMessageHandler,
  OutgoingFileConfig,
  ResolvedLocalFile,
  TelegramConfig,
} from '../types';
import * as path from 'node:path';
import { LRUCache } from 'lru-cache';
import { TelegramClient } from './telegram.client';
import { renderTelegram } from './telegram.renderer';
import { bridgeLogger } from '../logger';
import { resolveOutgoingLocalFiles } from '../bridge/outgoing.file';

export class TelegramAdapter implements BridgeAdapter {
  provider: 'telegram' = 'telegram';
  private static readonly TELEGRAM_TEXT_LIMIT = 3900;
  private readonly client: TelegramClient;
  private readonly pendingTyping = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pendingReactionByChat = new Map<string, string[]>();
  private readonly virtualToRealMessage = new LRUCache<string, string>({
    max: 6000,
    ttl: 6 * 60 * 60 * 1000,
  });
  private readonly freezeStreamingEdits = new Set<string>();
  private readonly lastRenderedByMsg = new LRUCache<string, string>({
    max: 6000,
    ttl: 3 * 60 * 60 * 1000,
  });
  private readonly sentFilesByMsg = new LRUCache<string, Set<string>>({
    max: 6000,
    ttl: 6 * 60 * 60 * 1000,
  });
  private readonly outgoingFileCfg: OutgoingFileConfig;

  constructor(config: TelegramConfig) {
    this.client = new TelegramClient(config);
    this.outgoingFileCfg = {
      enabled: Boolean(config.auto_send_local_files),
      maxMb: config.auto_send_local_files_max_mb ?? 20,
      allowAbsolute: Boolean(config.auto_send_local_files_allow_absolute),
    };
  }

  async start(handler: IncomingMessageHandler) {
    await this.client.start(handler);
    bridgeLogger.info('[Telegram] adapter started');
  }

  async stop() {
    for (const timer of this.pendingTyping.values()) clearInterval(timer);
    this.pendingTyping.clear();
    this.pendingReactionByChat.clear();
    this.virtualToRealMessage.clear();
    this.freezeStreamingEdits.clear();
    this.lastRenderedByMsg.clear();
    this.sentFilesByMsg.clear();
    await this.client.stop();
  }

  async sendMessage(chatId: string, markdown: string) {
    if (!this.isStreamingFlowDisplay(markdown)) {
      const rendered = this.normalizeForTelegram(renderTelegram(markdown));
      const sent = await this.client.sendMessage(chatId, rendered);
      if (sent) {
        this.lastRenderedByMsg.set(this.flowMessageKey(chatId, sent), rendered);
        await this.sendLocalFilesIfNeeded(chatId, sent, markdown, true);
        await this.clearPendingReactions(chatId);
      }
      return sent;
    }

    const virtualId = this.newVirtualMessageId();
    const key = this.flowMessageKey(chatId, virtualId);
    this.startTyping(chatId, key);
    bridgeLogger.info(`[Telegram] typing-start chat=${chatId} virtualMsg=${virtualId}`);
    return virtualId;
  }

  async editMessage(chatId: string, messageId: string, markdown: string) {
    const key = this.flowMessageKey(chatId, messageId);
    const resolvedMessageId = this.resolveMessageId(chatId, messageId);
    const targetMessageId = resolvedMessageId || messageId;
    const targetKey = this.flowMessageKey(chatId, targetMessageId);
    const rendered = this.normalizeForTelegram(renderTelegram(markdown));
    const isStreaming = this.isStreamingFlowDisplay(markdown);
    const isFinal = this.isFinalFlowDisplay(markdown);
    if (messageId.startsWith('typing:') && !this.pendingTyping.has(key)) {
      if (!resolvedMessageId) return false;
      if (this.freezeStreamingEdits.has(key) && isStreaming) return true;
      if (isFinal) this.freezeStreamingEdits.delete(key);
      if (this.lastRenderedByMsg.get(targetKey) === rendered) {
        await this.sendLocalFilesIfNeeded(
          chatId,
          resolvedMessageId,
          markdown,
          this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
        );
        if (!isStreaming) await this.clearPendingReactions(chatId);
        return true;
      }
      const ok = await this.client.editMessage(chatId, resolvedMessageId, rendered);
      if (ok) {
        this.lastRenderedByMsg.set(targetKey, rendered);
        await this.sendLocalFilesIfNeeded(
          chatId,
          resolvedMessageId,
          markdown,
          this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
        );
        if (!isStreaming) await this.clearPendingReactions(chatId);
      }
      return ok;
    }
    if (!this.pendingTyping.has(key)) {
      if (this.freezeStreamingEdits.has(key) && isStreaming) return true;
      if (isFinal) this.freezeStreamingEdits.delete(key);
      if (this.lastRenderedByMsg.get(targetKey) === rendered) {
        await this.sendLocalFilesIfNeeded(
          chatId,
          targetMessageId,
          markdown,
          this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
        );
        if (!isStreaming) await this.clearPendingReactions(chatId);
        return true;
      }
      const ok = await this.client.editMessage(chatId, targetMessageId, rendered);
      if (ok) {
        this.lastRenderedByMsg.set(targetKey, rendered);
        await this.sendLocalFilesIfNeeded(
          chatId,
          targetMessageId,
          markdown,
          this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
        );
        if (!isStreaming) await this.clearPendingReactions(chatId);
      }
      return ok;
    }

    if (isStreaming) {
      // Send one early preview message to reduce wait time, then freeze further streaming edits.
      if (this.hasAnswerContent(markdown)) {
        if (this.lastRenderedByMsg.get(targetKey) === rendered) return true;
        const sent = await this.client.sendMessage(chatId, rendered);
        if (sent) {
          this.virtualToRealMessage.set(key, sent);
          this.freezeStreamingEdits.add(key);
          this.lastRenderedByMsg.set(this.flowMessageKey(chatId, sent), rendered);
          this.stopTyping(key);
          bridgeLogger.info(
            `[Telegram] preview-send chat=${chatId} virtualMsg=${messageId} realMsg=${sent}`,
          );
          return true;
        }
      }
      await this.client.sendTyping(chatId).catch(() => {});
      return true;
    }
    if (!isFinal) return true;

    this.stopTyping(key);
    this.freezeStreamingEdits.delete(key);
    bridgeLogger.info(`[Telegram] typing-stop chat=${chatId} virtualMsg=${messageId}`);
    if (resolvedMessageId) {
      if (this.lastRenderedByMsg.get(targetKey) === rendered) {
        await this.sendLocalFilesIfNeeded(
          chatId,
          resolvedMessageId,
          markdown,
          this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
        );
        await this.clearPendingReactions(chatId);
        return true;
      }
      const ok = await this.client.editMessage(chatId, resolvedMessageId, rendered);
      if (!ok) return false;
      this.lastRenderedByMsg.set(targetKey, rendered);
      await this.sendLocalFilesIfNeeded(
        chatId,
        resolvedMessageId,
        markdown,
        this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
      );
    } else {
      const sent = await this.client.sendMessage(chatId, rendered);
      if (!sent) return false;
      this.virtualToRealMessage.set(key, sent);
      this.lastRenderedByMsg.set(this.flowMessageKey(chatId, sent), rendered);
      await this.sendLocalFilesIfNeeded(
        chatId,
        sent,
        markdown,
        this.shouldSendLocalFilesNow(markdown, isStreaming, isFinal),
      );
    }
    await this.clearPendingReactions(chatId);
    return true;
  }

  async addReaction(messageRef: string, emojiType: string): Promise<string | null> {
    const emoji = this.mapEmoji(emojiType);
    const tryEmojis = emoji === '👍' ? ['👍'] : [emoji, '👍'];
    for (const e of tryEmojis) {
      try {
        const ok = await this.client.setReactionByIncomingMessageId(messageRef, e);
        if (ok) {
          const chatId = this.client.getChatIdByIncomingMessageId(messageRef);
          if (chatId) this.enqueuePendingReaction(chatId, messageRef);
          return `${messageRef}:${e}`;
        }
      } catch (err) {
        bridgeLogger.warn(
          `[Telegram] addReaction failed msg=${messageRef} emoji=${e}`,
          err,
        );
      }
    }
    return null;
  }

  async removeReaction(messageRef: string, _reactionId: string): Promise<void> {
    const chatId = this.client.getChatIdByIncomingMessageId(messageRef);
    if (!chatId) {
      bridgeLogger.warn(`[Telegram] removeReaction skipped: missing chat mapping msg=${messageRef}`);
      return;
    }
    this.enqueuePendingReaction(chatId, messageRef);
  }

  async sendLocalFile(chatId: string, localPath: string): Promise<boolean> {
    try {
      const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), localPath);
      const out = await this.client.sendDocument({
        chatId,
        absPath,
        filename: path.basename(absPath),
      });
      const ok = Boolean(out);
      bridgeLogger.info(
        `[Telegram] command sendLocalFile chat=${chatId} path=${absPath} ok=${ok}`,
      );
      return ok;
    } catch (err) {
      bridgeLogger.warn(
        `[Telegram] command sendLocalFile failed chat=${chatId} path=${localPath}`,
        err,
      );
      return false;
    }
  }

  private flowMessageKey(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  private newVirtualMessageId(): string {
    return `typing:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  }

  private startTyping(chatId: string, key: string): void {
    this.stopTyping(key);
    void this.client.sendTyping(chatId).catch(() => {});
    const timer = setInterval(() => {
      void this.client.sendTyping(chatId).catch(() => {});
    }, 4000);
    this.pendingTyping.set(key, timer);
  }

  private stopTyping(key: string): void {
    const timer = this.pendingTyping.get(key);
    if (timer) clearInterval(timer);
    this.pendingTyping.delete(key);
  }

  private statusLine(markdown: string): string {
    const text = (markdown || '').trim();
    const m = text.match(/##\s*Status\s*\n([^\n]+)/i);
    return (m?.[1] || '').toLowerCase();
  }

  private isFlowDisplay(markdown: string): boolean {
    return /##\s*Status/i.test((markdown || '').trim());
  }

  private isStreamingFlowDisplay(markdown: string): boolean {
    if (!this.isFlowDisplay(markdown)) return false;
    return this.statusLine(markdown).includes('streaming');
  }

  private isFinalFlowDisplay(markdown: string): boolean {
    if (!this.isFlowDisplay(markdown)) return false;
    const statusLine = this.statusLine(markdown);
    if (statusLine.includes('streaming')) return false;
    return (
      statusLine.includes('done') ||
      statusLine.includes('completed') ||
      statusLine.includes('aborted') ||
      statusLine.includes('error')
    );
  }

  private shouldSendLocalFilesNow(markdown: string, isStreaming: boolean, isFinal: boolean): boolean {
    if (!this.outgoingFileCfg.enabled) return false;
    if (!this.isFlowDisplay(markdown)) return true;
    if (isStreaming) return false;
    return isFinal;
  }

  private localFileSignature(file: ResolvedLocalFile): string {
    return `${file.absPath}|${file.size}|${file.mtimeMs}`;
  }

  private async sendLocalFilesIfNeeded(
    chatId: string,
    messageId: string,
    markdown: string,
    allowNow: boolean,
  ): Promise<void> {
    if (!allowNow) return;
    const resolved = await resolveOutgoingLocalFiles(markdown, this.outgoingFileCfg);
    if (resolved.files.length === 0) return;

    const key = this.flowMessageKey(chatId, messageId);
    const sent = this.sentFilesByMsg.get(key) || new Set<string>();
    let sentCount = 0;
    let skipCount = 0;
    for (const file of resolved.files) {
      const sig = this.localFileSignature(file);
      if (sent.has(sig)) {
        skipCount++;
        continue;
      }
      try {
        const out = await this.client.sendDocument({
          chatId,
          absPath: file.absPath,
          filename: file.filename,
          mime: file.mime,
        });
        if (out) {
          sent.add(sig);
          sentCount++;
        }
      } catch (err) {
        bridgeLogger.warn(
          `[Telegram] outgoing local file send failed chat=${chatId} msg=${messageId} path=${file.absPath}`,
          err,
        );
      }
    }
    this.sentFilesByMsg.set(key, sent);
    bridgeLogger.info(
      `[Telegram] outgoing local files chat=${chatId} msg=${messageId} matched=${resolved.files.length} rejected=${resolved.rejected.length} sent=${sentCount} skipped=${skipCount}`,
    );
  }

  private mapEmoji(emojiType: string): string {
    if (emojiType === 'Typing') return '🤔';
    return emojiType || '🤔';
  }

  private resolveMessageId(chatId: string, messageId: string): string | null {
    if (!messageId.startsWith('typing:')) return messageId;
    return this.virtualToRealMessage.get(this.flowMessageKey(chatId, messageId)) || null;
  }

  private hasAnswerContent(markdown: string): boolean {
    const text = (markdown || '').trim();
    const m = text.match(/##\s*Answer\s*\n([\s\S]*?)(?:\n##\s+\S+|$)/i);
    if (!m?.[1]) return false;
    return m[1].trim().length > 0;
  }

  private normalizeForTelegram(text: string): string {
    if (!text) return '';
    if (text.length <= TelegramAdapter.TELEGRAM_TEXT_LIMIT) return text;
    return `${text.slice(0, TelegramAdapter.TELEGRAM_TEXT_LIMIT)}\n\n... (truncated, len=${text.length})`;
  }

  private enqueuePendingReaction(chatId: string, messageRef: string): void {
    const queue = this.pendingReactionByChat.get(chatId) || [];
    if (!queue.includes(messageRef)) queue.push(messageRef);
    this.pendingReactionByChat.set(chatId, queue);
  }

  private async clearPendingReactions(chatId: string): Promise<void> {
    const queue = this.pendingReactionByChat.get(chatId);
    if (!queue || queue.length === 0) return;
    while (queue.length > 0) {
      const messageRef = queue.shift();
      if (!messageRef) continue;
      try {
        await this.client.clearReactionByIncomingMessageId(messageRef);
      } catch (err) {
        bridgeLogger.warn(`[Telegram] clear pending reaction failed msg=${messageRef}`, err);
      }
    }
    this.pendingReactionByChat.delete(chatId);
  }
}
