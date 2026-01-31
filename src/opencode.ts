// src/opencode.ts
import type {
  SessionCreateData,
  SessionPromptData,
  SessionMessagesData,
  SessionListData,
} from '@opencode-ai/sdk';

export interface OpenCodeApi {
  createSession: (data: Omit<SessionCreateData, 'url'>) => Promise<any>;
  promptSession: (data: Omit<SessionPromptData, 'url'>) => Promise<any>;
  getMessages: (data: Omit<SessionMessagesData, 'url'>) => Promise<any>;
  getSessionList: (data: Omit<SessionListData, 'url'>) => Promise<any>;
}

const findMethod = (client: any, name: string, namespace?: string) => {
  if (client[name]) return client[name].bind(client);
  if (
    namespace &&
    client[namespace] &&
    client[namespace][name.replace(namespace, '').toLowerCase()]
  ) {
    return client[namespace][name.replace(namespace, '').toLowerCase()].bind(client[namespace]);
  }
  if (namespace && client[namespace] && client[namespace][name]) {
    return client[namespace][name].bind(client[namespace]);
  }
  return null;
};

export const buildOpenCodeApi = (client: any): OpenCodeApi => {
  return {
    createSession: findMethod(client, 'sessionCreate', 'session'),
    promptSession: findMethod(client, 'sessionPrompt', 'session'),
    getMessages: findMethod(client, 'sessionMessages', 'session'),
    getSessionList: findMethod(client, 'sessionList', 'session'),
  };
};
