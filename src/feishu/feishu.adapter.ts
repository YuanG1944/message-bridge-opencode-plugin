import type {
  BridgeAdapter,
  FeishuConfig,
  IncomingMessageHandler,
  OutgoingFileConfig,
  ResolvedLocalFile,
} from '../types';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LRUCache } from 'lru-cache';
import { FeishuClient } from './feishu.client';
import { FeishuRenderer, extractFilesFromHandlerMarkdown, RenderedFile } from './feishu.renderer';
import { resolveOutgoingLocalFiles } from '../bridge/outgoing.file';
import { bridgeLogger } from '../logger';

function clip(s: string, n = 8000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n... (clipped, len=${s.length})` : s;
}

export class FeishuAdapter implements BridgeAdapter {
  private client: FeishuClient;
  private renderer: FeishuRenderer;
  private config: FeishuConfig;
  private sentFilesByMessage: LRUCache<string, Set<string>>;
  private outgoingFileCfg: OutgoingFileConfig;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.client = new FeishuClient(config);
    this.renderer = new FeishuRenderer();
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

  async start(onMessage: IncomingMessageHandler): Promise<void> {
    if (this.config.mode === 'webhook') {
      await this.client.startWebhook(onMessage);
    } else {
      await this.client.startWebSocket(onMessage);
    }
  }

  async stop(): Promise<void> {
    this.sentFilesByMessage.clear();
    await this.client.stop();
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    const files = await this.collectOutgoingFiles(text);
    const sentSignatures = await this.sendNewFiles(chatId, files, undefined);
    bridgeLogger.info(
      `[Feishu] outgoing files chat=${chatId} candidates=${files.length} sent=${sentSignatures.size}`,
    );
    const messageId = await this.client.sendMessage(chatId, this.renderer.render(text));
    if (messageId && sentSignatures.size > 0) {
      this.sentFilesByMessage.set(messageId, sentSignatures);
    }
    return messageId;
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    const files = await this.collectOutgoingFiles(text);
    const sent = this.sentFilesByMessage.get(messageId);
    const newSent = await this.sendNewFiles(chatId, files, sent);
    bridgeLogger.info(
      `[Feishu] outgoing files(edit) chat=${chatId} msg=${messageId} candidates=${files.length} sent=${newSent.size}`,
    );
    if (newSent.size > 0) {
      const merged = new Set([...(sent || []), ...newSent]);
      this.sentFilesByMessage.set(messageId, merged);
    }
    return this.client.editMessage(chatId, messageId, this.renderer.render(text));
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    return this.client.addReaction(messageId, emojiType);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.client.removeReaction(messageId, reactionId);
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
        `[Feishu] command sendLocalFile chat=${chatId} path=${absPath} ok=${ok}`,
      );
      return ok;
    } catch (err) {
      bridgeLogger.warn(
        `[Feishu] command sendLocalFile failed chat=${chatId} path=${localPath}`,
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
        `[Feishu] outgoing local files rejected count=${resolved.rejected.length} sample=${resolved.rejected
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
        bridgeLogger.debug(`[Feishu] outgoing duplicate skip sig=${sig}`);
        continue;
      }
      const ok = await this.client.sendFileAttachment(chatId, f);
      if (ok) sentNow.add(sig);
    }
    return sentNow;
  }

}
