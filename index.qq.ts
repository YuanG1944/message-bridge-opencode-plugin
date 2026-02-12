// index.qq.ts
import type { Config } from '@opencode-ai/sdk';
import type { BridgeAdapter, QQConfig } from './src/types';
import { asRecord, globalState } from './src/utils';
import { AGENT_QQ } from './src/constants';
import { bridgeLogger } from './src/logger';

export function parseQQConfig(cfg: Config | undefined): QQConfig {
  const node = cfg?.agent?.[AGENT_QQ];
  const options = asRecord(node?.options);

  const app_id = typeof options.app_id === 'string' ? options.app_id : '';
  // 支持 secret 或 app_secret（兼容不同配置方式）
  const secretRaw = typeof options.secret === 'string' ? options.secret : 
                    typeof options.app_secret === 'string' ? options.app_secret : undefined;
  const secret = secretRaw || '';
  const mode = options.mode === 'webhook' ? 'webhook' : 'ws';
  const callbackUrlRaw = options.callback_url;
  const fileStoreDirRaw = options.file_store_dir;
  const callbackUrl =
    typeof callbackUrlRaw === 'string' && callbackUrlRaw.length > 0
      ? callbackUrlRaw.startsWith('http')
        ? callbackUrlRaw
        : `http://${callbackUrlRaw}`
      : undefined;
  const file_store_dir =
    typeof fileStoreDirRaw === 'string' && fileStoreDirRaw.trim().length > 0
      ? fileStoreDirRaw.trim()
      : undefined;

  if (mode === 'webhook' && !callbackUrl) {
    bridgeLogger.warn(`[Plugin] Missing callback_url for ${AGENT_QQ} in webhook mode`);
  }

  if (!app_id || !secret) {
    const missing = [];
    if (!app_id) missing.push('app_id');
    if (!secret) missing.push('secret');
    throw new Error(
      `[Plugin] Missing required options for ${AGENT_QQ}: ${missing.join(', ')}. ` +
      `Please check your opencode.json configuration.`,
    );
  }

  const maxMbRaw = Number(options.auto_send_local_files_max_mb);
  const auto_send_local_files =
    options.auto_send_local_files === true || options.auto_send_local_files === 'true';
  const auto_send_local_files_allow_absolute =
    options.auto_send_local_files_allow_absolute === true ||
    options.auto_send_local_files_allow_absolute === 'true';
  const auto_send_local_files_max_mb =
    Number.isFinite(maxMbRaw) && maxMbRaw > 0 ? maxMbRaw : 20;

  const webhookListenPortRaw = Number(options.webhook_listen_port);
  const webhook_listen_port =
    Number.isFinite(webhookListenPortRaw) && webhookListenPortRaw > 0
      ? webhookListenPortRaw
      : undefined;

  const encrypt_key = typeof options.encrypt_key === 'string' ? options.encrypt_key : undefined;

  return {
    app_id,
    secret,
    mode,
    callback_url: callbackUrl,
    webhook_listen_port,
    encrypt_key,
    file_store_dir,
    auto_send_local_files,
    auto_send_local_files_max_mb,
    auto_send_local_files_allow_absolute,
  };
}
