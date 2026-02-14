import type {
  BridgeAdapter,
  QQConfig,
  IncomingMessageHandler,
  OutgoingFileConfig,
  ResolvedLocalFile,
} from '../types';
import type { TextPartInput, FilePartInput } from '@opencode-ai/sdk';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LRUCache } from 'lru-cache';
import { QQClient } from './qq.client';
import { QQRenderer, extractFilesFromHandlerMarkdown, RenderedFile } from './qq.renderer';
import { resolveOutgoingLocalFiles } from '../bridge/outgoing.file';
import { bridgeLogger } from '../logger';

function clip(s: string, n = 8000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n... (clipped, len=${s.length})` : s;
}

export class QQAdapter implements BridgeAdapter {
  private client: QQClient;
  private renderer: QQRenderer;
  private config: QQConfig;
  private sentFilesByMessage: LRUCache<string, Set<string>>;
  private outgoingFileCfg: OutgoingFileConfig;
  private pendingStreamingMessages: LRUCache<string, true> = new LRUCache<string, true>({
    max: 4000,
    ttl: 2 * 60 * 60 * 1000,
  });
  private virtualMessageCounter: number = 0;
  private virtualToRealMessage: LRUCache<string, string> = new LRUCache<string, string>({
    max: 6000,
    ttl: 6 * 60 * 60 * 1000,
  });
  // 保存每个 chatId 对应的最后一条用户消息 ID（用于群聊回复）
  private lastUserMessageIdByChat: LRUCache<string, string> = new LRUCache<string, string>({
    max: 4000,
    ttl: 24 * 60 * 60 * 1000,
  });

  constructor(config: QQConfig) {
    this.config = config;
    this.client = new QQClient(config);
    this.renderer = new QQRenderer();
    this.sentFilesByMessage = new LRUCache<string, Set<string>>({
      max: 6000,
      ttl: 6 * 60 * 60 * 1000,
    });
    this.outgoingFileCfg = {
      enabled: Boolean(config.auto_send_local_files),
      maxMb: config.auto_send_local_files_max_mb ?? 20,
      allowAbsolute: Boolean(config.auto_send_local_files_allow_absolute),
    };
  }

  private newVirtualMessageId(): string {
    return `streaming:${++this.virtualMessageCounter}`;
  }

  private resolveMessageId(chatId: string, messageId: string): string | null {
    const key = `${chatId}:${messageId}`;
    return this.virtualToRealMessage.get(key) || null;
  }

  private flowMessageKey(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  async start(onMessage: IncomingMessageHandler): Promise<void> {
    // 包装 onMessage，保存用户消息 ID
    const wrappedHandler: IncomingMessageHandler = async (
      chatId: string,
      text: string,
      messageId: string,
      senderId: string,
      parts?: Array<TextPartInput | FilePartInput>,
    ) => {
      // 保存用户消息 ID（用于群聊回复）
      this.lastUserMessageIdByChat.set(chatId, messageId);
      // 调用原始 handler
      await onMessage(chatId, text, messageId, senderId, parts);
    };

    if (this.config.mode === 'webhook') {
      await this.client.startWebhook(wrappedHandler);
    } else {
      await this.client.startWebSocket(wrappedHandler);
    }
  }

  async stop(): Promise<void> {
    this.sentFilesByMessage.clear();
    this.pendingStreamingMessages.clear();
    this.virtualToRealMessage.clear();
    this.lastUserMessageIdByChat.clear();
    await this.client.stop();
  }

  private isFlowDisplay(markdown: string): boolean {
    return /##\s*Status/i.test((markdown || '').trim());
  }

  private statusLine(markdown: string): string {
    const match = markdown.match(/##\s*Status[:\s]*([^\n]*)/i);
    return match ? (match[1] || '').toLowerCase() : '';
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

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    const isStreaming = this.isStreamingFlowDisplay(text);
    const isFinal = this.isFinalFlowDisplay(text);

    // 如果是流式输出且未完成，返回虚拟 messageId，避免反复发送
    if (isStreaming && !isFinal) {
      const virtualId = this.newVirtualMessageId();
      const key = this.flowMessageKey(chatId, virtualId);
      this.pendingStreamingMessages.set(key, true);
      bridgeLogger.debug(`[QQ] streaming in progress, return virtual msg chat=${chatId} virtualMsg=${virtualId}`);
      return virtualId;
    }

    // 流式输出完成，清除标记并发送消息
    if (isFinal) {
      // 清除所有相关的流式标记
      for (const key of this.pendingStreamingMessages.keys()) {
        if (key.startsWith(`${chatId}:`)) {
          this.pendingStreamingMessages.delete(key);
        }
      }
    }

    const files = await this.collectOutgoingFiles(text);
    const sentSignatures = await this.sendNewFiles(chatId, files, undefined);
    bridgeLogger.info(
      `[QQ] outgoing files chat=${chatId} candidates=${files.length} sent=${sentSignatures.size}`,
    );
    // 获取最后一条用户消息 ID（用于群聊回复）
    const lastUserMsgId = this.lastUserMessageIdByChat.get(chatId);
    const messageId = await this.client.sendMessage(chatId, this.renderer.render(text), lastUserMsgId);
    if (messageId && sentSignatures.size > 0) {
      this.sentFilesByMessage.set(messageId, sentSignatures);
    }
    return messageId;
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    const isStreaming = this.isStreamingFlowDisplay(text);
    const isFinal = this.isFinalFlowDisplay(text);
    const key = this.flowMessageKey(chatId, messageId);
    const resolvedMessageId = this.resolveMessageId(chatId, messageId);
    const targetMessageId = resolvedMessageId || messageId;

    // 如果是虚拟 messageId（流式输出）
    if (messageId.startsWith('streaming:')) {
      // 如果已经解析到真实 messageId，说明已经发送过最终消息
      // QQ不支持编辑消息，直接返回true避免触发fallback
      if (resolvedMessageId) {
        const files = await this.collectOutgoingFiles(text);
        const sent = this.sentFilesByMessage.get(resolvedMessageId);
        const newSent = await this.sendNewFiles(chatId, files, sent);
        bridgeLogger.info(
          `[QQ] outgoing files(edit) chat=${chatId} msg=${resolvedMessageId} candidates=${files.length} sent=${newSent.size}`,
        );
        if (newSent.size > 0) {
          const merged = new Set([...(sent || []), ...newSent]);
          this.sentFilesByMessage.set(resolvedMessageId, merged);
        }
        // QQ不支持编辑消息，返回true表示"成功"（但不实际编辑）
        bridgeLogger.debug(`[QQ] edit skipped (not supported) chat=${chatId} msg=${resolvedMessageId}`);
        return true;
      }

      // 如果是流式输出且未完成，不编辑消息
      if (isStreaming && !isFinal) {
        if (!this.pendingStreamingMessages.get(key)) {
          this.pendingStreamingMessages.set(key, true);
        }
        bridgeLogger.debug(`[QQ] streaming in progress, skip edit chat=${chatId} virtualMsg=${messageId}`);
        return true; // 返回 true 表示"成功"，但不实际编辑
      }

      // 流式输出完成，发送真实消息（只发送一次）
      if (isFinal) {
        this.pendingStreamingMessages.delete(key);
        const files = await this.collectOutgoingFiles(text);
        const sentSignatures = await this.sendNewFiles(chatId, files, undefined);
        bridgeLogger.info(
          `[QQ] streaming complete, send final message chat=${chatId} candidates=${files.length} sent=${sentSignatures.size}`,
        );
        // 获取最后一条用户消息 ID（用于群聊回复）
        const lastUserMsgId = this.lastUserMessageIdByChat.get(chatId);
        const realMessageId = await this.client.sendMessage(chatId, this.renderer.render(text), lastUserMsgId);
        if (realMessageId) {
          // 建立虚拟ID到真实ID的映射
          this.virtualToRealMessage.set(key, realMessageId);
          if (sentSignatures.size > 0) {
            this.sentFilesByMessage.set(realMessageId, sentSignatures);
          }
          bridgeLogger.info(`[QQ] streaming final message sent chat=${chatId} virtualMsg=${messageId} realMsg=${realMessageId}`);
          return true;
        }
        return false;
      }
      return true;
    }

    // 真实 messageId 的编辑逻辑
    // QQ不支持编辑消息，如果消息已经存在，直接返回true避免触发fallback
    if (this.sentFilesByMessage.has(targetMessageId) || resolvedMessageId) {
      const files = await this.collectOutgoingFiles(text);
      const sent = this.sentFilesByMessage.get(targetMessageId);
      const newSent = await this.sendNewFiles(chatId, files, sent);
      bridgeLogger.info(
        `[QQ] outgoing files(edit) chat=${chatId} msg=${targetMessageId} candidates=${files.length} sent=${newSent.size}`,
      );
      if (newSent.size > 0) {
        const merged = new Set([...(sent || []), ...newSent]);
        this.sentFilesByMessage.set(targetMessageId, merged);
      }
      // QQ不支持编辑消息，返回true表示"成功"（但不实际编辑）
      bridgeLogger.debug(`[QQ] edit skipped (not supported) chat=${chatId} msg=${targetMessageId}`);
      return true;
    }

    // 如果消息不存在，也不应该编辑，返回true
    bridgeLogger.debug(`[QQ] edit skipped (message not found) chat=${chatId} msg=${targetMessageId}`);
    return true;
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    // QQ频道机器人暂不支持reaction，返回null
    bridgeLogger.debug(`[QQ] addReaction not supported msg=${messageId} emoji=${emojiType}`);
    return null;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    // QQ频道机器人暂不支持reaction
    bridgeLogger.debug(`[QQ] removeReaction not supported msg=${messageId} reaction=${reactionId}`);
  }

  async sendLocalFile(chatId: string, localPath: string): Promise<boolean> {
    try {
      const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), localPath);
      const fileUrl = pathToFileURL(absPath).toString();
      const filename = path.basename(absPath);
      const ok = await this.client.sendFileAttachment(chatId, {
        filename,
        url: fileUrl,
      });
      bridgeLogger.info(
        `[QQ] command sendLocalFile chat=${chatId} path=${absPath} ok=${ok}`,
      );
      return ok;
    } catch (err) {
      bridgeLogger.warn(
        `[QQ] command sendLocalFile failed chat=${chatId} path=${localPath}`,
        err,
      );
      return false;
    }
  }

  private fileSignature(file: RenderedFile): string {
    const s = `${file.filename || ''}|${file.mime || ''}|${file.url || ''}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return String(h);
  }

  private localFileToRendered(file: ResolvedLocalFile): RenderedFile {
    return {
      filename: file.filename,
      mime: file.mime,
      url: `file://${file.absPath}`,
    };
  }

  private async collectOutgoingFiles(markdown: string): Promise<RenderedFile[]> {
    const fromFilesSection = extractFilesFromHandlerMarkdown(markdown);
    if (!this.outgoingFileCfg.enabled) return fromFilesSection;

    const resolved = await resolveOutgoingLocalFiles(markdown, this.outgoingFileCfg);
    if (resolved.rejected.length > 0) {
      bridgeLogger.info(
        `[QQ] outgoing local files rejected count=${resolved.rejected.length} sample=${resolved.rejected
          .slice(0, 3)
          .map(r => `${r.ref}:${r.reason}`)
          .join(',')}`,
      );
    }
    const localFiles = resolved.files.map(f => this.localFileToRendered(f));
    return [...fromFilesSection, ...localFiles];
  }

  private async sendNewFiles(
    chatId: string,
    files: RenderedFile[],
    sent?: Set<string>
  ): Promise<Set<string>> {
    const sentNow = new Set<string>();
    for (const f of files) {
      if (!f.url) continue;
      const sig = this.fileSignature(f);
      if (sent?.has(sig)) {
        bridgeLogger.debug(`[QQ] outgoing duplicate skip sig=${sig}`);
        continue;
      }
      const ok = await this.client.sendFileAttachment(chatId, f);
      if (ok) sentNow.add(sig);
    }
    return sentNow;
  }
}
