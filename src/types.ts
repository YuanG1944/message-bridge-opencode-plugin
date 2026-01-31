export interface FeishuConfig {
  appId: string;
  appSecret: string;
  port?: number;
  path?: string;
  mode?: 'ws' | 'webhook';
  encryptKey?: string;
}
