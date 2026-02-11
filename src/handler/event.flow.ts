import type {
  EventCommandExecuted,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionError,
  EventSessionIdle,
  OpencodeClient,
} from '@opencode-ai/sdk';
import type { ToolPart } from '@opencode-ai/sdk';
import type { BridgeAdapter } from '../types';
import type { AdapterMux } from './mux';
import { bridgeLogger } from '../logger';
import {
  simpleHash,
  getOrInitBuffer,
  markStatus,
  applyPartToBuffer,
  shouldFlushNow,
} from '../bridge/buffer';
import type { MessageBuffer } from '../bridge/buffer';
import {
  safeEditWithRetry,
  flushAll as flushAllMessages,
  flushMessage as flushOneMessage,
} from './message.delivery';
import {
  buildFinalizedExecutionContent,
  buildPlatformDisplay,
  carryPlatformMessage,
  FLOW_LOG_PREFIX,
  shouldCarryPlatformMessageAcrossAssistantMessages,
  shouldSplitOutFinalAnswer,
  splitFinalAnswerFromExecution,
} from './execution.flow';
import {
  extractQuestionPayload,
  isQuestionToolError,
  isQuestionToolPart,
  QUESTION_TIMEOUT_MS,
  renderQuestionPrompt,
} from './question.proxy';
import type { PendingQuestionState, NormalizedQuestionPayload } from './question.proxy';

type SessionContext = { chatId: string; senderId: string };
type SelectedModel = { providerID: string; modelID: string; name?: string };
type ListenerState = { isListenerStarted: boolean; shouldStopListener: boolean };
type EventWithType = { type: string; properties?: unknown };
type EventMessageBuffer = MessageBuffer & { __executionCarried?: boolean };
const QUESTION_DEBUG_MAX_LEN = 4000;
const ROUTE_MISS_WARN_INTERVAL_MS = 30_000;
const lastRouteMissWarnAt = new Map<string, number>();
const forwardedSchedulerUserParts = new Set<string>();

export type EventFlowDeps = {
  listenerState: ListenerState;
  sessionToCtx: Map<string, SessionContext>;
  sessionActiveMsg: Map<string, string>;
  msgRole: Map<string, string>;
  msgBuffers: Map<string, EventMessageBuffer>;
  sessionCache: Map<string, string>;
  sessionToAdapterKey: Map<string, string>;
  chatAgent: Map<string, string>;
  chatModel: Map<string, SelectedModel>;
  chatSessionList: Map<string, Array<{ id: string; title: string }>>;
  chatAgentList: Map<string, Array<{ id: string; name: string }>>;
  chatAwaitingSaveFile: Map<string, boolean>;
  chatMaxFileSizeMb: Map<string, number>;
  chatMaxFileRetry: Map<string, number>;
  chatPendingQuestion: Map<string, PendingQuestionState>;
  pendingQuestionTimers: Map<string, NodeJS.Timeout>;
  isQuestionCallHandled: (cacheKey: string, messageId: string, callID: string) => boolean;
  markQuestionCallHandled: (cacheKey: string, messageId: string, callID: string) => void;
};

function clearPendingQuestionForChat(deps: EventFlowDeps, cacheKey: string) {
  const timer = deps.pendingQuestionTimers.get(cacheKey);
  if (timer) {
    clearTimeout(timer);
    deps.pendingQuestionTimers.delete(cacheKey);
  }
  deps.chatPendingQuestion.delete(cacheKey);
}

function clearAllPendingQuestions(deps: EventFlowDeps) {
  for (const timer of deps.pendingQuestionTimers.values()) {
    clearTimeout(timer);
  }
  deps.pendingQuestionTimers.clear();
  deps.chatPendingQuestion.clear();
}

function getCacheKeyBySession(
  sessionId: string,
  deps: EventFlowDeps,
): { cacheKey: string; adapterKey: string; chatId: string } | null {
  const ctx = deps.sessionToCtx.get(sessionId);
  const adapterKey = deps.sessionToAdapterKey.get(sessionId);
  if (!ctx || !adapterKey) return null;
  return {
    cacheKey: `${adapterKey}:${ctx.chatId}`,
    adapterKey,
    chatId: ctx.chatId,
  };
}

function readStringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function summarizeObservedEvent(event: unknown): Record<string, unknown> {
  const e = event as { type?: string; properties?: unknown };
  const props = (e?.properties ?? {}) as Record<string, unknown>;
  const info =
    props.info && typeof props.info === 'object'
      ? (props.info as Record<string, unknown>)
      : undefined;
  const part =
    props.part && typeof props.part === 'object'
      ? (props.part as Record<string, unknown>)
      : undefined;

  return {
    type: typeof e?.type === 'string' ? e.type : 'unknown',
    session_id:
      readStringField(props, 'sessionID') ??
      readStringField(info ?? {}, 'sessionID') ??
      readStringField(part ?? {}, 'sessionID'),
    message_id: readStringField(info ?? {}, 'id') ?? readStringField(part ?? {}, 'messageID'),
    role: readStringField(info ?? {}, 'role'),
    part_type: readStringField(part ?? {}, 'type'),
    part_id: readStringField(part ?? {}, 'id'),
    has_delta: typeof props.delta === 'string' && props.delta.length > 0,
    has_part_metadata:
      !!part &&
      typeof (part as { metadata?: unknown }).metadata === 'object' &&
      (part as { metadata?: unknown }).metadata !== null,
  };
}

function isSchedulerCallbackMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const obj = metadata as Record<string, unknown>;
  const source = readStringField(obj, 'source');
  if (source === 'scheduler.callback') {
    return true;
  }
  if (obj.bridge === true && typeof obj.task_id === 'string') {
    return true;
  }
  return typeof obj.task_id === 'string' && typeof obj.run_id === 'string';
}

function warnRouteMissOnce(eventType: string, sessionId: string, messageId?: string): void {
  const key = `${eventType}:${sessionId}`;
  const now = Date.now();
  const last = lastRouteMissWarnAt.get(key) ?? 0;
  if (now - last < ROUTE_MISS_WARN_INTERVAL_MS) {
    return;
  }
  lastRouteMissWarnAt.set(key, now);
  bridgeLogger.warn(
    `[BridgeFlow] route.miss event=${eventType} sid=${sessionId} mid=${messageId || '-'} (session has no chat mapping in memory)`,
  );
}

function hydrateSessionRouteFromMetadata(
  sessionId: string,
  metadata: unknown,
  deps: EventFlowDeps,
): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const root = metadata as Record<string, unknown>;
  const nested =
    root.route && typeof root.route === 'object'
      ? (root.route as Record<string, unknown>)
      : undefined;
  const source = nested ?? root;

  const chatId = readStringField(source, 'chat_id', 'chatId');
  const adapterKey = readStringField(source, 'adapter_key', 'adapterKey', 'adapter');
  const senderId = readStringField(source, 'sender_id', 'senderId') ?? 'system';

  if (!chatId || !adapterKey) {
    return false;
  }

  const existingCtx = deps.sessionToCtx.get(sessionId);
  const existingAdapter = deps.sessionToAdapterKey.get(sessionId);
  if (!existingCtx) {
    deps.sessionToCtx.set(sessionId, { chatId, senderId });
  }
  if (!existingAdapter) {
    deps.sessionToAdapterKey.set(sessionId, adapterKey);
  }
  if (!existingCtx || !existingAdapter) {
    bridgeLogger.info(
      `[BridgeFlow] hydrated-session-route sid=${sessionId} adapter=${adapterKey} chat=${chatId}`,
    );
  }
  return true;
}

function clipDebugText(value: string, max = QUESTION_DEBUG_MAX_LEN): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...<truncated>`;
}

async function captureQuestionProxyIfNeeded(params: {
  part: ToolPart;
  sessionId: string;
  messageId: string;
  api: OpencodeClient;
  mux: AdapterMux;
  deps: EventFlowDeps;
}): Promise<boolean> {
  const { part, sessionId, messageId, api, mux, deps } = params;
  if (!isQuestionToolPart(part)) return false;

  const payloadMaybe = extractQuestionPayload(part?.state?.input);
  if (payloadMaybe === null) return false;
  const payload: NormalizedQuestionPayload = payloadMaybe;

  const sessionCtx = getCacheKeyBySession(sessionId, deps);

  if (!sessionCtx) return false;

  const { cacheKey, adapterKey, chatId } = sessionCtx;
  const callID = part.callID || `question-${messageId}`;
  if (deps.isQuestionCallHandled(cacheKey, messageId, callID)) return false;

  const existing = deps.chatPendingQuestion.get(cacheKey);
  if (existing && existing.callID === callID && existing.messageId === messageId) {
    return true;
  }

  clearPendingQuestionForChat(deps, cacheKey);

  const pending: PendingQuestionState = {
    key: cacheKey,
    adapterKey,
    chatId,
    sessionId,
    messageId,
    callID,
    payload,
    createdAt: Date.now(),
    dueAt: Date.now() + QUESTION_TIMEOUT_MS,
  };

  deps.chatPendingQuestion.set(cacheKey, pending);

  const adapter = mux.get(adapterKey);
  if (adapter) {
    await adapter.sendMessage(chatId, renderQuestionPrompt(pending)).catch(() => {});
  }

  const timer = setTimeout(async () => {
    const current = deps.chatPendingQuestion.get(cacheKey);
    if (!current || current.callID !== callID || current.messageId !== messageId) return;

    deps.markQuestionCallHandled(cacheKey, messageId, callID);
    clearPendingQuestionForChat(deps, cacheKey);
    const currentAdapter = mux.get(current.adapterKey);
    if (currentAdapter) {
      await currentAdapter
        .sendMessage(current.chatId, '## Status\n⏰ 超时，本轮提问已取消。请重新发起问题。')
        .catch(() => {});
    }
  }, QUESTION_TIMEOUT_MS);

  deps.pendingQuestionTimers.set(cacheKey, timer);
  return true;
}

function isAbortedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'MessageAbortedError'
  );
}

function isOutputLengthError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'MessageOutputLengthError'
  );
}

function isApiError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'APIError';
}

async function finalizeExecutionCardBeforeSplit(
  adapter: BridgeAdapter,
  chatId: string,
  buffer: EventMessageBuffer,
) {
  if (!buffer?.platformMsgId) return;
  const finalContent = buildFinalizedExecutionContent(buffer);
  await safeEditWithRetry(adapter, chatId, buffer.platformMsgId, finalContent).catch(() => {});
  bridgeLogger.info(`${FLOW_LOG_PREFIX} execution-finalized chat=${chatId}`);
}

async function flushMessage(
  adapter: BridgeAdapter,
  chatId: string,
  messageId: string,
  msgBuffers: Map<string, EventMessageBuffer>,
  force = false,
) {
  await flushOneMessage({
    adapter,
    chatId,
    messageId,
    msgBuffers,
    buildDisplay: buildPlatformDisplay,
    force,
  });
}

async function flushAll(mux: AdapterMux, deps: EventFlowDeps) {
  await flushAllMessages({
    mux,
    sessionActiveMsg: deps.sessionActiveMsg,
    sessionToCtx: deps.sessionToCtx,
    sessionToAdapterKey: deps.sessionToAdapterKey,
    msgBuffers: deps.msgBuffers,
    buildDisplay: buildPlatformDisplay,
  });
}

function resolveSessionTarget(sessionId: string, mux: AdapterMux, deps: EventFlowDeps) {
  const ctx = deps.sessionToCtx.get(sessionId);
  const adapterKey = deps.sessionToAdapterKey.get(sessionId);
  const adapter = adapterKey ? mux.get(adapterKey) : undefined;
  if (!ctx || !adapter) return null;
  return { ctx, adapter };
}

async function handleMessageUpdatedEvent(
  event: EventMessageUpdated,
  mux: AdapterMux,
  deps: EventFlowDeps,
) {
  const info = event.properties.info;
  if (info?.id && info?.role) deps.msgRole.set(info.id, info.role);

  if (!(info?.role === 'assistant' && info?.id && info?.sessionID)) return;

  const sid = info.sessionID as string;
  const mid = info.id as string;

  const target = resolveSessionTarget(sid, mux, deps);
  if (!target) {
    warnRouteMissOnce('message.updated', sid, mid);
    return;
  }
  const { ctx, adapter } = target;

  const activeMid = deps.sessionActiveMsg.get(sid);
  if (!activeMid) {
    deps.sessionActiveMsg.set(sid, mid);
  }

  if (info.error) {
    const cache = getCacheKeyBySession(sid, deps);
    const pending = cache ? deps.chatPendingQuestion.get(cache.cacheKey) : undefined;

    if (pending && pending.messageId === mid) {
      markStatus(deps.msgBuffers, mid, 'done', 'awaiting-user-reply');
      await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
      return;
    }

    if (isAbortedError(info.error)) {
      markStatus(
        deps.msgBuffers,
        mid,
        'aborted',
        (info?.error?.data?.message as string) || 'aborted',
      );
    } else if (isOutputLengthError(info.error)) {
      markStatus(deps.msgBuffers, mid, 'error', 'output too long');
    } else if (isApiError(info.error)) {
      markStatus(
        deps.msgBuffers,
        mid,
        'error',
        (info.error?.data?.message as string) || 'api error',
      );
    } else {
      markStatus(
        deps.msgBuffers,
        mid,
        'error',
        (info.error?.data?.message as string) || info.error?.name || 'error',
      );
    }
    await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
    return;
  }

  if (info.finish || info.time?.completed) {
    markStatus(deps.msgBuffers, mid, 'done', info.finish || 'completed');
    await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
  }
}

async function handleMessagePartUpdatedEvent(
  event: EventMessagePartUpdated,
  api: OpencodeClient,
  mux: AdapterMux,
  deps: EventFlowDeps,
) {
  const part = event.properties.part;
  const delta: string | undefined = event.properties.delta;

  const sessionId = part.sessionID;
  const messageId = part.messageID;
  if (!sessionId || !messageId) return;

  const partMeta = (part as { metadata?: unknown }).metadata;
  if (partMeta) {
    hydrateSessionRouteFromMetadata(sessionId, partMeta, deps);
  }

  const target = resolveSessionTarget(sessionId, mux, deps);
  if (!target) {
    warnRouteMissOnce('message.part.updated', sessionId, messageId);
    return;
  }
  const { ctx, adapter } = target;

  // Scheduler callback messages are often user-role text parts.
  // Forward them as plain bridge output when we can identify callback metadata.
  if (
    deps.msgRole.get(messageId) === 'user' &&
    part.type === 'text' &&
    typeof part.text === 'string' &&
    isSchedulerCallbackMetadata(partMeta)
  ) {
    const dedupeKey = `${sessionId}:${messageId}:${part.id}`;
    if (forwardedSchedulerUserParts.has(dedupeKey)) {
      return;
    }
    forwardedSchedulerUserParts.add(dedupeKey);
    await adapter.sendMessage(ctx.chatId, part.text).catch(() => {});
    bridgeLogger.info(
      `[BridgeFlow] scheduler-user-part-forwarded sid=${sessionId} mid=${messageId} chat=${ctx.chatId}`,
    );
    return;
  }

  if (deps.msgRole.get(messageId) === 'user') return;
  const adapterKey = deps.sessionToAdapterKey.get(sessionId);
  const cacheKey = adapterKey ? `${adapterKey}:${ctx.chatId}` : '';

  const prev = deps.sessionActiveMsg.get(sessionId);
  if (prev && prev !== messageId) {
    const prevBuf = deps.msgBuffers.get(prev);
    const nextBuf = getOrInitBuffer(deps.msgBuffers, messageId);
    if (prevBuf && shouldCarryPlatformMessageAcrossAssistantMessages(prevBuf)) {
      carryPlatformMessage(prevBuf, nextBuf);
      bridgeLogger.info(
        `${FLOW_LOG_PREFIX} carry-execution sid=${sessionId} prev=${prev} next=${messageId}`,
      );
    } else {
      bridgeLogger.debug(
        `[BridgeFlowDebug] do-not-carry sid=${sessionId} prev=${prev} next=${messageId} prevPlatform=${prevBuf?.platformMsgId || '-'} prevTextLen=${(prevBuf?.text || '').length} prevReasoningLen=${(prevBuf?.reasoning || '').length} prevTools=${prevBuf?.tools?.size || 0}`,
      );
      markStatus(deps.msgBuffers, prev, 'done');
      await flushMessage(adapter, ctx.chatId, prev, deps.msgBuffers, true);
    }
  }
  deps.sessionActiveMsg.set(sessionId, messageId);

  const buffer = getOrInitBuffer(deps.msgBuffers, messageId);
  if (cacheKey) {
    const selectedAgent = deps.chatAgent.get(cacheKey);
    const selectedModel = deps.chatModel.get(cacheKey);
    buffer.selectedAgent = selectedAgent;
    buffer.selectedModel = selectedModel;
  }
  applyPartToBuffer(buffer, part, delta);

  if (
    part.type === 'tool' &&
    (await captureQuestionProxyIfNeeded({
      part: part as ToolPart,
      sessionId,
      messageId,
      api,
      mux,
      deps,
    }))
  ) {
    markStatus(deps.msgBuffers, messageId, 'done', 'awaiting-user-reply');
  }

  bridgeLogger.debug(
    `[BridgeFlowDebug] part-applied sid=${sessionId} mid=${messageId} part=${part.type} textLen=${buffer.text.length} reasoningLen=${buffer.reasoning.length} tools=${buffer.tools.size} status=${buffer.status} note="${buffer.statusNote || ''}" hasPlatform=${!!buffer.platformMsgId}`,
  );

  if (shouldSplitOutFinalAnswer(buffer)) {
    bridgeLogger.info(
      `${FLOW_LOG_PREFIX} split-final-answer sid=${sessionId} mid=${messageId} textLen=${buffer.text.length}`,
    );
    await finalizeExecutionCardBeforeSplit(adapter, ctx.chatId, buffer);
    splitFinalAnswerFromExecution(buffer);
  }

  if (part.type === 'step-finish' && buffer.status === 'streaming') {
    markStatus(deps.msgBuffers, messageId, 'done', part.reason || 'step-finish');
  }

  if (!shouldFlushNow(buffer, adapterKey || undefined)) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] skip-flush sid=${sessionId} mid=${messageId} reason=throttle`,
    );
    return;
  }
  const hasAny = buffer.reasoning.length > 0 || buffer.text.length > 0 || buffer.tools.size > 0;
  if (!hasAny) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] skip-flush sid=${sessionId} mid=${messageId} reason=empty`,
    );
    return;
  }

  buffer.lastUpdateTime = Date.now();

  const display = buildPlatformDisplay(buffer);
  const hash = simpleHash(display);
  if (buffer.platformMsgId && hash === buffer.lastDisplayHash) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] skip-flush sid=${sessionId} mid=${messageId} reason=same-hash`,
    );
    return;
  }

  if (!buffer.platformMsgId) {
    bridgeLogger.info(
      `${FLOW_LOG_PREFIX} send-new sid=${sessionId} mid=${messageId} tools=${buffer.tools.size}`,
    );
    const sent = await adapter.sendMessage(ctx.chatId, display);
    if (sent) {
      buffer.platformMsgId = sent;
      buffer.lastDisplayHash = hash;
    }
    return;
  }

  const ok = await safeEditWithRetry(adapter, ctx.chatId, buffer.platformMsgId, display);
  if (ok) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] edited sid=${sessionId} mid=${messageId} msg=${ok} contentLen=${display.length}`,
    );
    buffer.platformMsgId = ok;
    buffer.lastDisplayHash = hash;
  } else {
    bridgeLogger.warn(
      `[BridgeFlowDebug] edit-failed sid=${sessionId} mid=${messageId} msg=${buffer.platformMsgId} contentLen=${display.length}`,
    );
  }
}

async function handleSessionErrorEvent(
  event: EventSessionError,
  mux: AdapterMux,
  deps: EventFlowDeps,
) {
  const sid = event.properties.sessionID;
  const err = event.properties.error;
  if (!sid) return;

  const target = resolveSessionTarget(sid, mux, deps);
  if (!target) {
    warnRouteMissOnce('session.error', sid);
    return;
  }
  const { ctx, adapter } = target;
  const mid = deps.sessionActiveMsg.get(sid);
  if (!mid) return;

  if (isAbortedError(err)) {
    markStatus(deps.msgBuffers, mid, 'aborted', (err?.data?.message as string) || 'aborted');
  } else {
    markStatus(
      deps.msgBuffers,
      mid,
      'error',
      (err?.data?.message as string) || err?.name || 'session.error',
    );
  }
  const errMsg =
    (err as { data?: { message?: string } })?.data?.message ||
    (err as { message?: string })?.message ||
    '-';
  bridgeLogger.warn(
    `[BridgeFlow] session-error sid=${sid} mid=${mid} name=${err?.name || '-'} msg=${errMsg}`,
  );
  await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
}

async function handleSessionIdleEvent(
  event: EventSessionIdle,
  mux: AdapterMux,
  deps: EventFlowDeps,
) {
  const sid = event.properties.sessionID;
  if (!sid) return;

  const target = resolveSessionTarget(sid, mux, deps);
  if (!target) {
    warnRouteMissOnce('session.idle', sid);
    return;
  }
  const { ctx, adapter } = target;
  const mid = deps.sessionActiveMsg.get(sid);
  if (!mid) return;

  const buf = deps.msgBuffers.get(mid);
  if (buf && (buf.status === 'aborted' || buf.status === 'error')) {
    await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
    return;
  }
  markStatus(deps.msgBuffers, mid, 'done', 'idle');
  await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
}

function handleCommandExecutedEvent(event: EventCommandExecuted, deps: EventFlowDeps) {
  const mid = event.properties.messageID;
  if (!mid) return;
  const buf = getOrInitBuffer(deps.msgBuffers, mid);
  buf.isCommand = true;
}

export async function startGlobalEventListenerWithDeps(
  api: OpencodeClient,
  mux: AdapterMux,
  deps: EventFlowDeps,
) {
  if (deps.listenerState.isListenerStarted) {
    bridgeLogger.debug('[BridgeFlowDebug] listener already started, skip');
    return;
  }
  deps.listenerState.isListenerStarted = true;
  deps.listenerState.shouldStopListener = false;

  bridgeLogger.info('[Listener] starting global event subscription (MUX)');

  let retryCount = 0;

  const connect = async () => {
    try {
      const events = await api.event.subscribe();
      bridgeLogger.info('[Listener] connected to OpenCode event stream');
      retryCount = 0;

      for await (const event of events.stream) {
        const e = event as EventWithType;
        if (deps.listenerState.shouldStopListener) break;
        bridgeLogger.info('[BridgeFlow] event.observed', summarizeObservedEvent(event));

        if (e.type === 'message.updated') {
          await handleMessageUpdatedEvent(event as EventMessageUpdated, mux, deps);
          continue;
        }

        if (e.type === 'message.part.updated') {
          const pe = event as EventMessagePartUpdated;
          const p = pe.properties.part;
          bridgeLogger.debug(
            `[BridgeFlowDebug] part.updated sid=${p.sessionID} mid=${p.messageID} type=${p.type} deltaLen=${(pe.properties.delta || '').length}`,
          );
          await handleMessagePartUpdatedEvent(event as EventMessagePartUpdated, api, mux, deps);
          continue;
        }

        if (e.type === 'session.error') {
          await handleSessionErrorEvent(event as EventSessionError, mux, deps);
          continue;
        }

        if (e.type === 'session.idle') {
          await handleSessionIdleEvent(event as EventSessionIdle, mux, deps);
          continue;
        }

        if (e.type === 'command.executed') {
          handleCommandExecutedEvent(event as EventCommandExecuted, deps);
          continue;
        }
      }

      await flushAll(mux, deps);
    } catch (e) {
      if (deps.listenerState.shouldStopListener) return;

      bridgeLogger.error('[Listener] stream disconnected', e);
      await flushAll(mux, deps);

      const delay = Math.min(5000 * (retryCount + 1), 60000);
      retryCount++;
      setTimeout(connect, delay);
    }
  };

  connect();
}

export function stopGlobalEventListenerWithDeps(deps: EventFlowDeps) {
  deps.listenerState.shouldStopListener = true;
  deps.listenerState.isListenerStarted = false;

  deps.sessionToCtx.clear();
  deps.sessionActiveMsg.clear();
  deps.msgRole.clear();
  deps.msgBuffers.clear();
  deps.sessionCache.clear();
  deps.sessionToAdapterKey.clear();
  deps.chatAgent.clear();
  deps.chatModel.clear();
  deps.chatSessionList.clear();
  deps.chatAgentList.clear();
  deps.chatAwaitingSaveFile.clear();
  deps.chatMaxFileSizeMb.clear();
  deps.chatMaxFileRetry.clear();
  
  clearAllPendingQuestions(deps);
}
