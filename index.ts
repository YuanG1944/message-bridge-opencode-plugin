import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';
import { FeishuClient } from './src/feishu';
import { buildOpenCodeApi } from './src/opencode';
import { createMessageHandler } from './src/handler';
import type { FeishuConfig } from './src/types';
import { PLUGIN_CONFIG_NAME } from './src/constants';

export const FeishuBridgePlugin: Plugin = async ctx => {
  const { client } = ctx;

  console.log('[Plugin] Plugin Loaded. Initiating background bootstrap sequence...');

  const bootstrap = async () => {
    try {
      console.log('[Plugin] [Step 1/4] Attempting to retrieve global configuration...');

      const configPromise = client.config.get();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Config API Timeout (3000ms)')), 3000),
      );

      let fullConfig: any = {};
      try {
        fullConfig = await Promise.race([configPromise, timeoutPromise]);
        console.log('[Plugin] ✅ Configuration retrieved successfully from Client.');
      } catch (e) {
        console.warn(
          '[Plugin] ⚠️ Configuration retrieval timed out or failed. Falling back to environment variables/defaults.',
          e,
        );
      }

      console.log('[Plugin] [Step 2/4] Parsing plugin options...');

      const agentConfig = fullConfig.data as Config;
      const pluginNameStr = PLUGIN_CONFIG_NAME;

      if (!pluginNameStr) {
        console.error(
          `[Plugin] ❌ Fatal Error: constant PLUGIN_CONFIG_NAME is undefined or empty!`,
        );
        return;
      }

      console.log(`[Plugin] Reading options for agent: "${pluginNameStr}"`);

      const larkConfig = (agentConfig?.agent?.[pluginNameStr]?.options || {}) as Record<
        string,
        any
      >;

      const appId = larkConfig.app_id;
      const appSecret = larkConfig.app_secret;
      const encryptKey = larkConfig?.encrypt_key || '';

      const portStr = larkConfig?.port || '';
      const pathStr = larkConfig?.path || '';
      const mode = (larkConfig.mode || 'ws').toLowerCase();

      console.log(
        `[Plugin] Parsed Config -> Mode: ${mode} | Port: ${portStr || 'N/A'} | AppID: ${appId ? appId.substring(0, 6) + '******' : 'MISSING'}`,
      );

      if (!appId || !appSecret) {
        console.error(
          `[Plugin] ❌ Startup Failed: Missing AppID or AppSecret!\nPlease check your configuration in 'opencode.json' or .env file.`,
        );
        return;
      }

      if (mode === 'webhook' && !encryptKey) {
        console.warn(
          '[Plugin] ⚠️ Warning: Webhook mode is enabled but "encrypt_key" is missing. Please ensure encryption is disabled in Feishu console, or provide the key.',
        );
      }

      console.log('[Plugin] [Step 3/4] Initializing internal components...');

      const config: FeishuConfig = {
        appId,
        appSecret,
        port: portStr ? parseInt(portStr, 10) : undefined,
        path: pathStr,
        encryptKey,
        mode: mode as 'ws' | 'webhook',
      };

      const api = buildOpenCodeApi(client);
      const feishuClient = new FeishuClient(config);
      const messageHandler = createMessageHandler(api, feishuClient);

      console.log(`[Plugin] [Step 4/4] Starting service in [${mode.toUpperCase()}] mode...`);

      if (config.mode === 'webhook') {
        await feishuClient.startWebhook(messageHandler);
      } else {
        await feishuClient.startWebSocket(messageHandler);
      }

      console.log(`[Plugin] 🚀 Feishu Bridge Service started successfully!`);
    } catch (error) {
      console.error('[Plugin] ❌ Bootstrap Fatal Error:', error);
    }
  };

  bootstrap();

  return {};
};
