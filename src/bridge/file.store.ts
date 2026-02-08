// src/bridge/fileStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { FilePartInput } from '@opencode-ai/sdk';
import { bridgeLogger } from '../logger';

export type StoredFileRecord = {
  id: string;
  chatKey: string;
  filename: string;
  mime: string;
  path: string;
  size: number;
  savedAt: number;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'save failed';
}

type SaveResult = {
  ok: boolean;
  record?: StoredFileRecord;
  duplicated?: boolean;
  error?: string;
};

const pendingFiles = new Map<string, StoredFileRecord[]>();
const seenFiles = new Map<string, Map<string, StoredFileRecord>>();

const DEFAULT_STORE_DIR =
  process.env.BRIDGE_FILE_STORE_DIR || path.join(process.cwd(), 'bridge_files');

function sanitizeSegment(value: string): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function inferExtFromMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('image/png')) return '.png';
  if (m.includes('image/jpeg')) return '.jpg';
  if (m.includes('image/webp')) return '.webp';
  if (m.includes('image/gif')) return '.gif';
  if (m.includes('image/bmp')) return '.bmp';
  if (m.includes('image/tiff')) return '.tiff';
  if (m.includes('image/x-icon')) return '.ico';
  if (m.includes('application/pdf')) return '.pdf';
  if (m.includes('wordprocessingml') || m.includes('application/msword')) return '.docx';
  if (m.includes('spreadsheetml') || m.includes('application/vnd.ms-excel')) return '.xlsx';
  if (m.includes('presentationml') || m.includes('application/vnd.ms-powerpoint')) return '.pptx';
  if (m.includes('video/mp4')) return '.mp4';
  if (m.includes('audio/opus')) return '.opus';
  return '';
}

function decodeDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
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

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildFilePath(chatKey: string, filename: string, mime: string): string {
  const safeChat = sanitizeSegment(chatKey || 'chat');
  const baseDir = path.join(DEFAULT_STORE_DIR, safeChat);
  const safeName = sanitizeSegment(path.basename(filename || 'file')) || 'file';
  const hasExt = path.extname(safeName);
  const ext = hasExt ? '' : inferExtFromMime(mime);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalName = `${safeName.replace(/\.+$/, '')}-${stamp}${ext}`;
  return path.join(baseDir, finalName);
}

export async function saveFilePartToLocal(
  chatKey: string,
  part: FilePartInput,
  options?: { enqueue?: boolean },
): Promise<SaveResult> {
  try {
    if (!part?.url) return { ok: false, error: 'missing url' };

    let buffer: Buffer | null = null;
    let mime = part.mime || 'application/octet-stream';

    if (part.url.startsWith('data:')) {
      const decoded = decodeDataUrl(part.url);
      if (!decoded) return { ok: false, error: 'invalid data url' };
      buffer = decoded.buffer;
      if (!part.mime) mime = decoded.mime || mime;
    } else if (part.url.startsWith('file://')) {
      const filePath = part.url.replace(/^file:\/\//, '');
      buffer = await fs.readFile(filePath);
    } else {
      return { ok: false, error: 'unsupported url' };
    }

    if (!buffer) return { ok: false, error: 'empty buffer' };

    const filename = part.filename || 'file';
    const digest = hashBuffer(buffer);

    let seenByChat = seenFiles.get(chatKey);
    if (!seenByChat) {
      seenByChat = new Map<string, StoredFileRecord>();
      seenFiles.set(chatKey, seenByChat);
    }

    const existing = seenByChat.get(digest);
    if (existing && (await fileExists(existing.path))) {
      bridgeLogger.info(
        `[FileStore] 🟡 duplicate skipped chat=${chatKey} name=${filename} path=${existing.path}`,
      );
      return { ok: true, record: existing, duplicated: true };
    }

    const destPath = buildFilePath(chatKey, filename, mime);
    await ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, buffer);

    const record: StoredFileRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      chatKey,
      filename,
      mime,
      path: destPath,
      size: buffer.length,
      savedAt: Date.now(),
    };

    seenByChat.set(digest, record);

    const enqueue = options?.enqueue !== false;
    if (enqueue) {
      const list = pendingFiles.get(chatKey) || [];
      list.push(record);
      pendingFiles.set(chatKey, list);
    }

    bridgeLogger.info(
      `[FileStore] ✅ saved chat=${chatKey} name=${filename} size=${buffer.length} path=${destPath}`,
    );

    return { ok: true, record };
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    bridgeLogger.error('[FileStore] ❌ save failed', {
      chatKey,
      filename: part?.filename,
      mime: part?.mime,
      error: message,
    });
    return { ok: false, error: message };
  }
}

export async function drainPendingFileParts(chatKey: string): Promise<FilePartInput[]> {
  const list = pendingFiles.get(chatKey) || [];
  pendingFiles.delete(chatKey);
  if (list.length > 0) {
    bridgeLogger.info(`[FileStore] 📤 draining ${list.length} file(s) chat=${chatKey}`);
  }

  const parts: FilePartInput[] = [];
  for (const record of list) {
    try {
      const buffer = await fs.readFile(record.path);
      const dataUrl = `data:${record.mime};base64,${buffer.toString('base64')}`;
      parts.push({
        type: 'file',
        mime: record.mime,
        filename: record.filename,
        url: dataUrl,
      });
      bridgeLogger.info(`[FileStore] ✅ queued for prompt path=${record.path}`);
    } catch {
      bridgeLogger.warn(`[FileStore] ⚠️ missing file on disk, skip: ${record.path}`);
      // ignore missing file, but keep moving
    }
  }

  return parts;
}

export function peekPendingFileRecords(chatKey: string): StoredFileRecord[] {
  return pendingFiles.get(chatKey) || [];
}
