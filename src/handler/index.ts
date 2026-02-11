// src/handler/index.ts
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { MessageBuffer } from '../bridge/buffer';
import { AdapterMux } from './mux';
import { createIncomingHandlerWithDeps } from './incoming.flow';
import { startGlobalEventListenerWithDeps, stopGlobalEventListenerWithDeps } from './event.flow';
import { globalState } from '../utils';
import type { PendingQuestionState } from './question.proxy';
import type { PendingAuthorizationState } from './authorization.proxy';
import { extractErrorMessage } from './api.response';

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
const chatPendingQuestion = new Map<string, PendingQuestionState>();
const pendingQuestionTimers = new Map<string, NodeJS.Timeout>();
const chatHandledQuestionCalls = new Map<string, Set<string>>();
const chatPendingAuthorization = new Map<string, PendingAuthorizationState>();
const pendingAuthorizationTimers = new Map<string, NodeJS.Timeout>();
globalState.__bridge_max_file_size = chatMaxFileSizeMb;
globalState.__bridge_max_file_retry = chatMaxFileRetry;

const listenerState = { isListenerStarted: false, shouldStopListener: false };

function buildQuestionCallToken(messageId: string, callID: string): string {
  return `${messageId}::${callID}`;
}

function markQuestionCallHandled(cacheKey: string, messageId: string, callID: string) {
  const token = buildQuestionCallToken(messageId, callID);
  const set = chatHandledQuestionCalls.get(cacheKey) || new Set<string>();
  set.add(token);
  if (set.size > 200) {
    const first = set.values().next().value as string | undefined;
    if (first) set.delete(first);
  }
  chatHandledQuestionCalls.set(cacheKey, set);
}

function isQuestionCallHandled(cacheKey: string, messageId: string, callID: string): boolean {
  const token = buildQuestionCallToken(messageId, callID);
  return chatHandledQuestionCalls.get(cacheKey)?.has(token) === true;
}

function clearHandledQuestionCallsForChat(cacheKey: string) {
  chatHandledQuestionCalls.delete(cacheKey);
}

function clearAllHandledQuestionCalls() {
  chatHandledQuestionCalls.clear();
}

function formatUserError(err: unknown): string {
  const msg = extractErrorMessage(err) || 'unknown error';
  if (msg.toLowerCase().includes('socket connection was closed unexpectedly')) {
    return '网络异常，资源下载失败，请稍后重试。';
  }
  return msg.split('\n')[0].slice(0, 200);
}

function clearPendingQuestionForChat(cacheKey: string) {
  const timer = pendingQuestionTimers.get(cacheKey);
  if (timer) {
    clearTimeout(timer);
    pendingQuestionTimers.delete(cacheKey);
  }
  chatPendingQuestion.delete(cacheKey);
}

function clearAllPendingQuestions() {
  for (const timer of pendingQuestionTimers.values()) {
    clearTimeout(timer);
  }
  pendingQuestionTimers.clear();
  chatPendingQuestion.clear();
  clearAllHandledQuestionCalls();
}

function clearPendingAuthorizationForChat(cacheKey: string) {
  const timer = pendingAuthorizationTimers.get(cacheKey);
  if (timer) {
    clearTimeout(timer);
    pendingAuthorizationTimers.delete(cacheKey);
  }
  chatPendingAuthorization.delete(cacheKey);
}

function clearAllPendingAuthorizations() {
  for (const timer of pendingAuthorizationTimers.values()) {
    clearTimeout(timer);
  }
  pendingAuthorizationTimers.clear();
  chatPendingAuthorization.clear();
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
    chatPendingQuestion,
    chatPendingAuthorization,
    pendingQuestionTimers,
    pendingAuthorizationTimers,
    isQuestionCallHandled,
    markQuestionCallHandled,
  });
}

export function stopGlobalEventListener() {
  clearAllPendingAuthorizations();
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
    chatPendingQuestion,
    chatPendingAuthorization,
    pendingQuestionTimers,
    pendingAuthorizationTimers,
    isQuestionCallHandled,
    markQuestionCallHandled,
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
    chatPendingQuestion,
    chatPendingAuthorization,
    pendingAuthorizationTimers,
    clearPendingQuestionForChat,
    clearPendingAuthorizationForChat,
    markQuestionCallHandled,
    clearAllPendingQuestions,
    formatUserError,
  });
