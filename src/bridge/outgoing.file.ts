import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutgoingFileConfig, ResolvedLocalFile } from '../types';

type ResolveResult = {
  files: ResolvedLocalFile[];
  rejected: Array<{ ref: string; reason: string }>;
};

function trimToken(token: string): string {
  return token
    .trim()
    .replace(/^["'`<({\[]+/, '')
    .replace(/["'`>)}\],.;:!?]+$/, '');
}

function parseSection(markdown: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+\\S|$)`, 'i');
  const m = markdown.match(re);
  return (m?.[1] || '').trim();
}

function pathTokensFromText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const patterns = [
    /file:\/\/[^\s<>"'`]+/g,
    /(?:^|\s)([A-Za-z]:[\\/][^\s<>"'`]+)/g,
    /(?:^|\s)(\\\\[^\s\\/:*?"<>|]+\\[^\s<>"'`]+)/g,
    /(?:^|\s)(\/[^\s<>"'`]+)/g,
    /(?:^|\s)(\.\.?\/[^\s<>"'`]+)/g,
    /(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(text)) !== null) {
      const token = trimToken(m[1] || m[0]);
      if (token) out.push(token);
    }
  }
  return out;
}

function candidatesFromFilesSection(filesSection: string): string[] {
  const lines = filesSection
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ')) continue;
    const token = trimToken(line);
    if (!token) continue;
    if (token.startsWith('http://') || token.startsWith('https://')) continue;
    out.push(token);
  }
  return out;
}

function inferMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tiff' || ext === '.tif') return 'image/tiff';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt' || ext === '.md' || ext === '.log') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.opus') return 'audio/opus';
  return 'application/octet-stream';
}

function isWindowsDrivePath(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(raw);
}

function isUNCPath(raw: string): boolean {
  return /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+/.test(raw);
}

function toAbsolutePath(raw: string): string {
  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return '';
    }
  }
  if (isWindowsDrivePath(raw) || isUNCPath(raw)) {
    return path.normalize(raw);
  }
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(process.cwd(), raw);
}

function isAbsoluteRef(raw: string): boolean {
  if (raw.startsWith('file://')) return true;
  if (isWindowsDrivePath(raw) || isUNCPath(raw)) return true;
  return path.isAbsolute(raw);
}

export async function resolveOutgoingLocalFiles(
  markdown: string,
  cfg: OutgoingFileConfig,
): Promise<ResolveResult> {
  if (!cfg.enabled) return { files: [], rejected: [] };

  const filesSection = parseSection(markdown || '', 'Files');
  const answerSection = parseSection(markdown || '', 'Answer') || markdown || '';
  const refs = [...candidatesFromFilesSection(filesSection), ...pathTokensFromText(answerSection)];

  const maxBytes = Math.max(1, Math.floor(cfg.maxMb * 1024 * 1024));
  const rejected: Array<{ ref: string; reason: string }> = [];
  const seen = new Set<string>();
  const files: ResolvedLocalFile[] = [];

  for (const ref of refs) {
    const abs = toAbsolutePath(ref);
    if (!abs) {
      rejected.push({ ref, reason: 'invalid-path' });
      continue;
    }
    if (!cfg.allowAbsolute && isAbsoluteRef(ref)) {
      rejected.push({ ref, reason: 'absolute-not-allowed' });
      continue;
    }

    try {
      await fs.access(abs);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        rejected.push({ ref, reason: 'not-file' });
        continue;
      }
      if (stat.size > maxBytes) {
        rejected.push({ ref, reason: 'too-large' });
        continue;
      }
      const real = await fs.realpath(abs);
      const key = `${real}|${stat.size}|${stat.mtimeMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        absPath: real,
        filename: path.basename(real),
        mime: inferMime(real),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        rawRef: ref,
      });
    } catch {
      rejected.push({ ref, reason: 'unreadable-or-missing' });
    }
  }

  return { files, rejected };
}
