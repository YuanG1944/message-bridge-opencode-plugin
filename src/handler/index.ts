// src/handler/index.ts
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { MessageBuffer } from '../bridge/buffer';
import { AdapterMux } from './mux';
import { createIncomingHandlerWithDeps } from './incoming.flow';
import { startGlobalEventListenerWithDeps, stopGlobalEventListenerWithDeps } from './event.flow';
import { globalState } from '../utils';

type SessionContext = { chatId: string; senderId: string };
type SelectedModel = { providerID: string; modelID: string; name?: string };

const sessionToCtx = new Map<string, SessionContext>(); // sessionId -> chat context
const sessionActiveMsg = new Map<string, string>(); // sessionId -> active assistant messageID
const msgRole = new Map<string, string>(); // messageId -> role
const msgBuffers = new Map<string, MessageBuffer>(); // messageId -> buffer
const sessionCache = new Map<string, string>(); // adapterKey:chatId -> sessionId
const sessionToAdapterKey = new Map<string, string>(); // sessionId -> adapterKey
const chatAgent = new Map<string, string>(); // adapterKey:chatId -> agent
const chatModel = new Map<string, SelectedModel>(); // adapterKey:chatId -> model
const chatSessionList = new Map<string, Array<{ id: string; title: string }>>();
const chatAgentList = new Map<string, Array<{ id: string; name: string }>>();
const chatAwaitingSaveFile = new Map<string, boolean>(); // adapterKey:chatId -> awaiting upload for /savefile
const chatMaxFileSizeMb: Map<string, number> =
  globalState.__bridge_max_file_size || new Map<string, number>();
const chatMaxFileRetry: Map<string, number> =
  globalState.__bridge_max_file_retry || new Map<string, number>();
globalState.__bridge_max_file_size = chatMaxFileSizeMb;
globalState.__bridge_max_file_retry = chatMaxFileRetry;

const listenerState = { isListenerStarted: false, shouldStopListener: false };

function formatUserError(err: unknown): string {
  const e = err as { message?: string; data?: { message?: string } };
  const msg = String(e?.message || e?.data?.message || 'unknown error');
  if (msg.toLowerCase().includes('socket connection was closed unexpectedly')) {
    return '网络异常，资源下载失败，请稍后重试。';
  }
  return msg.split('\n')[0].slice(0, 200);
}

export async function startGlobalEventListener(api: OpencodeClient, mux: AdapterMux) {
  await startGlobalEventListenerWithDeps(api, mux, {
    listenerState,
    sessionToCtx,
    sessionActiveMsg,
    msgRole,
    msgBuffers,
    sessionCache,
    sessionToAdapterKey,
    chatAgent,
    chatModel,
    chatSessionList,
    chatAgentList,
    chatAwaitingSaveFile,
    chatMaxFileSizeMb,
    chatMaxFileRetry,
  });
}

export function stopGlobalEventListener() {
  stopGlobalEventListenerWithDeps({
    listenerState,
    sessionToCtx,
    sessionActiveMsg,
    msgRole,
    msgBuffers,
    sessionCache,
    sessionToAdapterKey,
    chatAgent,
    chatModel,
    chatSessionList,
    chatAgentList,
    chatAwaitingSaveFile,
    chatMaxFileSizeMb,
    chatMaxFileRetry,
  });
}

export const createIncomingHandler = (api: OpencodeClient, mux: AdapterMux, adapterKey: string) =>
  createIncomingHandlerWithDeps(api, mux, adapterKey, {
    sessionCache,
    sessionToAdapterKey,
    sessionToCtx,
    chatAgent,
    chatModel,
    chatSessionList,
    chatAgentList,
    chatAwaitingSaveFile,
    chatMaxFileSizeMb,
    chatMaxFileRetry,
    formatUserError,
  });
