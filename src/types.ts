// src/types.ts
import type { FilePartInput, TextPartInput } from '@opencode-ai/sdk';

export type IncomingMessageHandler = (
  chatId: string,
  text: string,
  messageId: string,
  senderId: string,
  parts?: Array<TextPartInput | FilePartInput>,
) => Promise<void>;

export interface BridgeAdapter {
  start(onMessage: IncomingMessageHandler): Promise<void>;

  stop?(): Promise<void>;

  sendMessage(chatId: string, text: string): Promise<string | null>;

  editMessage(chatId: string, messageId: string, text: string): Promise<boolean>;

  addReaction?(messageId: string, emojiType: string): Promise<string | null>;

  removeReaction?(messageId: string, reactionId: string): Promise<void>;

  sendLocalFile?(chatId: string, localPath: string): Promise<boolean>;
}

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  mode: 'ws' | 'webhook';
  callback_url?: string;
  file_store_dir?: string;
  encrypt_key?: string;
  auto_send_local_files?: boolean;
  auto_send_local_files_max_mb?: number;
  auto_send_local_files_allow_absolute?: boolean;
}

export interface TelegramConfig {
  mode: 'polling' | 'webhook';
  bot_token: string;
  polling_timeout_sec: number;
  polling_interval_ms: number;
  callback_url?: string;
  webhook_listen_port?: number;
  webhook_secret_token?: string;
  file_store_dir?: string;
  auto_send_local_files?: boolean;
  auto_send_local_files_max_mb?: number;
  auto_send_local_files_allow_absolute?: boolean;
}

export interface QQConfig {
  app_id: string;
  secret: string;
  mode: 'ws' | 'webhook';
  callback_url?: string;
  webhook_listen_port?: number;
  encrypt_key?: string;
  file_store_dir?: string;
  auto_send_local_files?: boolean;
  auto_send_local_files_max_mb?: number;
  auto_send_local_files_allow_absolute?: boolean;
}

export type OutgoingFileConfig = {
  enabled: boolean;
  maxMb: number;
  allowAbsolute: boolean;
};

export type ResolvedLocalFile = {
  absPath: string;
  filename: string;
  mime: string;
  size: number;
  mtimeMs: number;
  rawRef: string;
};
