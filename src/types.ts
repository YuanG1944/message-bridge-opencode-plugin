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
}

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  mode: 'ws' | 'webhook';
  callback_url?: string;
  encrypt_key?: string;
}

export interface TelegramConfig {
  mode: 'polling' | 'webhook';
  bot_token: string;
  polling_timeout_sec: number;
  polling_interval_ms: number;
  callback_url?: string;
  webhook_secret_token?: string;
}
