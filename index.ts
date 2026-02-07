// index.ts
import type { Plugin } from '@opencode-ai/plugin';

import { globalState, isEnabled, runtimeInstanceId } from './src/utils';
import { AGENT_LARK, AGENT_IMESSAGE, AGENT_TELEGRAM } from './src/constants';
import { bridgeLogger, getBridgeLogFilePath } from './src/logger';

import { AdapterMux } from './src/handler/mux';
import { startGlobalEventListener, createIncomingHandler } from './src/handler';

import { FeishuAdapter } from './src/feishu/feishu.adapter';
import type { BridgeAdapter } from './src/types';
import { TelegramAdapter } from './src/telegram/telegram.adapter';

import { parseFeishuConfig } from './index.feishu';
import { parseTelegramConfig } from './index.telegram';

export const BridgePlugin: Plugin = async ctx => {
  const { client } = ctx;
  bridgeLogger.info(
    `[Plugin] bridge entry initializing logFile=${getBridgeLogFilePath()} pid=${process.pid} instance=${runtimeInstanceId}`,
  );

  const bootstrap = async () => {
    try {
      const raw = await client.config.get();
      const cfg = raw?.data;

      // mux 单例
      const mux: AdapterMux = globalState.__bridge_mux || new AdapterMux();
      globalState.__bridge_mux = mux;
      const adapterInstances: Map<string, BridgeAdapter> =
        globalState.__bridge_adapter_instances || new Map<string, BridgeAdapter>();
      const startedAdapters: Set<string> =
        globalState.__bridge_started_adapters || new Set<string>();
      const startingAdapters: Set<string> =
        globalState.__bridge_starting_adapters || new Set<string>();
      globalState.__bridge_adapter_instances = adapterInstances;
      globalState.__bridge_started_adapters = startedAdapters;
      globalState.__bridge_starting_adapters = startingAdapters;

      // 允许多个 adapter 同时启用
      const adaptersToStart: Array<{ key: string; create: () => BridgeAdapter }> = [];

      if (isEnabled(cfg, AGENT_LARK)) {
        const feishuCfg = parseFeishuConfig(cfg);
        adaptersToStart.push({ key: AGENT_LARK, create: () => new FeishuAdapter(feishuCfg) });
      }

      if (isEnabled(cfg, AGENT_TELEGRAM)) {
        const telegramCfg = parseTelegramConfig(cfg);
        adaptersToStart.push({
          key: AGENT_TELEGRAM,
          create: () => new TelegramAdapter(telegramCfg),
        });
      }

      if (isEnabled(cfg, AGENT_IMESSAGE)) {
        bridgeLogger.info('[Plugin] imessage-bridge enabled (not implemented yet).');
        // TODO: mux.register(AGENT_IMESSAGE, new IMessageAdapter(...))
      }

      if (adaptersToStart.length === 0) {
        bridgeLogger.info('[Plugin] no bridge enabled');
        return;
      }

      // 注册 + start（incoming）
      for (const { key, create } of adaptersToStart) {
        const adapter = adapterInstances.get(key) || create();
        adapterInstances.set(key, adapter);
        mux.register(key, adapter);
        if (startedAdapters.has(key)) {
          bridgeLogger.info(`[Plugin] adapter already started, skip start adapter=${key}`);
          continue;
        }
        if (startingAdapters.has(key)) {
          bridgeLogger.info(`[Plugin] adapter is starting, skip duplicate start adapter=${key}`);
          continue;
        }
        startingAdapters.add(key);
        const incoming = createIncomingHandler(client, mux, key);
        try {
          await adapter.start(incoming);
          startedAdapters.add(key);
          bridgeLogger.info(`[Plugin] started adapter=${key}`);
        } finally {
          startingAdapters.delete(key);
        }
      }

      // 全局 listener 只启动一次（mux）
      if (!globalState.__bridge_listener_started) {
        globalState.__bridge_listener_started = true;
        startGlobalEventListener(client, mux).catch(err => {
          bridgeLogger.error('[Plugin] startGlobalEventListener failed', err);
          globalState.__bridge_listener_started = false;
        });
      } else {
        bridgeLogger.info('[Plugin] global listener already started');
      }

      bridgeLogger.info('[Plugin] BridgePlugin ready');
    } catch (e) {
      bridgeLogger.error('[Plugin] bootstrap error', e);
    }
  };

  bootstrap();
  return {};
};
