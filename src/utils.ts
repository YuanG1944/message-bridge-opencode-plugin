// src/utils.ts
import { Config } from '@opencode-ai/sdk';
import type { BridgeGlobalState } from './global.state';
import {
  AGENT_TELEGRAM,
  BRIDGE_AGENT_IDS,
  TELEGRAM_UPDATE_INTERVAL,
  UPDATE_INTERVAL,
} from './constants';

export const globalState = globalThis as BridgeGlobalState;
export const runtimeInstanceId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const DEFAULT_MAX_FILE_MB = 10;
export const DEFAULT_MAX_FILE_RETRY = 3;
export const ERROR_HEADER = '## Error';

export function parseSlashCommand(text: string): { command: string; arguments: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed === '/') return null;

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const command = match[1]?.trim();
  if (!command) return null;

  const args = (match[2] ?? '').trim();
  return { command, arguments: args };
}

export function isEnabled(cfg: Config | undefined, key: string): boolean {
  const node = cfg?.agent?.[key];
  if (!node) return false;
  if (node.disable === true) return false;
  return true;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getUpdateIntervalByAdapter(adapterKey?: string): number {
  if (adapterKey === AGENT_TELEGRAM) return TELEGRAM_UPDATE_INTERVAL;
  return UPDATE_INTERVAL;
}

export function isBridgeAgentId(value: string): boolean {
  return BRIDGE_AGENT_IDS.includes(value as (typeof BRIDGE_AGENT_IDS)[number]);
}
