import type { Config } from '@opencode-ai/sdk';

import { asRecord } from './src/utils';
import { AGENT_TELEGRAM } from './src/constants';
import type { TelegramConfig } from './src/types';

export function parseTelegramConfig(cfg: Config | undefined): TelegramConfig {
  const node = cfg?.agent?.[AGENT_TELEGRAM];
  const options = asRecord(node?.options);

  const mode = options.mode === 'webhook' ? 'webhook' : 'polling';
  const botToken = typeof options.bot_token === 'string' ? options.bot_token.trim() : '';
  if (!botToken) {
    throw new Error(`[Plugin] Missing options for ${AGENT_TELEGRAM}: bot_token`);
  }

  const callbackUrlRaw = options.callback_url;

  const callbackUrl =
    typeof callbackUrlRaw === 'string' && callbackUrlRaw.length > 0
      ? callbackUrlRaw.startsWith('http')
        ? callbackUrlRaw
        : `http://${callbackUrlRaw}`
      : undefined;

  const timeoutRaw = Number(options.polling_timeout_sec);
  const intervalRaw = Number(options.polling_interval_ms);
  const polling_timeout_sec = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 20;
  const polling_interval_ms = Number.isFinite(intervalRaw) && intervalRaw >= 0 ? intervalRaw : 300;

  if (mode === 'webhook' && !callbackUrl) {
    throw new Error(`[Plugin] Missing options for ${AGENT_TELEGRAM} in webhook mode: callback_url`);
  }

  return {
    mode,
    bot_token: botToken,
    polling_timeout_sec,
    polling_interval_ms,
    callback_url: callbackUrl,
    webhook_secret_token:
      typeof options.webhook_secret_token === 'string'
        ? options.webhook_secret_token.trim()
        : undefined,
  };
}
