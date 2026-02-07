// index.feishu.ts
import type { Config } from '@opencode-ai/sdk';
import type { BridgeAdapter, FeishuConfig } from './src/types';
import { asRecord, globalState } from './src/utils';
import { AGENT_LARK } from './src/constants';
import { bridgeLogger } from './src/logger';

let feishuAdapter: BridgeAdapter | null = globalState.__bridge_feishu_adapter || null;

export function parseFeishuConfig(cfg: Config | undefined): FeishuConfig {
  const node = cfg?.agent?.[AGENT_LARK];
  const options = asRecord(node?.options);

  const app_id = typeof options.app_id === 'string' ? options.app_id : '';
  const app_secret = typeof options.app_secret === 'string' ? options.app_secret : '';
  const mode = options.mode === 'webhook' ? 'webhook' : 'ws';
  const callbackUrlRaw = options.callback_url;
  const callbackUrl =
    typeof callbackUrlRaw === 'string' && callbackUrlRaw.length > 0
      ? callbackUrlRaw.startsWith('http')
        ? callbackUrlRaw
        : `http://${callbackUrlRaw}`
      : undefined;

  if (mode === 'webhook' && !callbackUrl) {
    bridgeLogger.warn(`[Plugin] Missing callback_url for ${AGENT_LARK} in webhook mode`);
  }

  if (!app_id || !app_secret) {
    throw new Error(`[Plugin] Missing options for ${AGENT_LARK}: app_id/app_secret`);
  }

  return {
    app_id,
    app_secret,
    mode,
    callback_url: callbackUrl,
    encrypt_key: typeof options.encrypt_key === 'string' ? options.encrypt_key : undefined,
  };
}
