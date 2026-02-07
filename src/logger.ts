import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BridgeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const logFilePath =
  process.env.BRIDGE_LOG_FILE || path.join(process.cwd(), 'logs', 'bridge.log');
const stdoutEnabled = !['0', 'false', 'off', 'no'].includes(
  String(process.env.BRIDGE_LOG_STDOUT || 'true').toLowerCase(),
);
const debugEnabled = !['0', 'false', 'off', 'no'].includes(
  String(process.env.BRIDGE_DEBUG || 'false').toLowerCase(),
);

function formatLine(level: BridgeLogLevel, message: string): string {
  const levelEmoji =
    level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : level === 'DEBUG' ? '🪵' : 'ℹ️';
  let tagEmoji = '🔹';
  if (message.includes('[Incoming]')) tagEmoji = '📥';
  else if (message.includes('[Command]')) tagEmoji = '🧭';
  else if (message.includes('[Listener]')) tagEmoji = '🎧';
  else if (message.includes('[Plugin]')) tagEmoji = '🧩';
  else if (message.includes('[BridgeFlow]') || message.includes('[BridgeFlowDebug]')) tagEmoji = '⚙️';
  else if (message.includes('[Feishu]')) tagEmoji = '🪶';
  else if (message.includes('[Telegram]')) tagEmoji = '✈️';
  else if (message.includes('[FileStore]')) tagEmoji = '📁';
  return `[${new Date().toISOString()}] ${levelEmoji}  ${tagEmoji} [${level}] ${message}`;
}

function writeLine(line: string): void {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
  } catch {}
}

function stringifyMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (typeof meta === 'string') return meta;
  if (meta instanceof Error) return `${meta.name}: ${meta.message}\n${meta.stack || ''}`;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function log(level: BridgeLogLevel, message: string, meta?: unknown): void {
  const line = formatLine(level, message);
  const metaText = stringifyMeta(meta);
  const fullLine = metaText ? `${line} ${metaText}` : line;
  if (stdoutEnabled) {
    if (level === 'ERROR') console.error(fullLine);
    else if (level === 'WARN') console.warn(fullLine);
    else console.log(fullLine);
  }
  writeLine(fullLine);
}

export function getBridgeLogFilePath(): string {
  return logFilePath;
}

export const bridgeLogger = {
  debug(message: string, meta?: unknown) {
    if (!debugEnabled) return;
    log('DEBUG', message, meta);
  },
  info(message: string, meta?: unknown) {
    log('INFO', message, meta);
  },
  warn(message: string, meta?: unknown) {
    log('WARN', message, meta);
  },
  error(message: string, meta?: unknown) {
    log('ERROR', message, meta);
  },
};
