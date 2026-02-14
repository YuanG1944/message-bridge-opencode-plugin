import type {
  EventCommandExecuted,
  EventMessagePartUpdated,
  EventPermissionReplied,
  EventPermissionUpdated,
  EventMessageUpdated,
  EventSessionError,
  EventSessionIdle,
  OpencodeClient
} from '@opencode-ai/sdk';
import type { ToolPart } from '@opencode-ai/sdk';
import { LRUCache } from 'lru-cache';
import type { BridgeAdapter } from '../../types';
import type { AdapterMux } from '../mux';
import { bridgeLogger } from '../../logger';
import {
  simpleHash,
  getOrInitBuffer,
  markStatus,
  applyPartToBuffer,
  shouldFlushNow,
} from '../../bridge/buffer';
import {
  safeEditWithRetry,
  flushAll as flushAllMessages,
  flushMessage as flushOneMessage,
} from '../flow';
import {
  buildFinalizedExecutionContent,
  buildPlatformDisplay,
  carryPlatformMessage,
  FLOW_LOG_PREFIX,
  shouldCarryPlatformMessageAcrossAssistantMessages,
  shouldSplitOutFinalAnswer,
  splitFinalAnswerFromExecution,
} from '../flow';
import { extractErrorMessage } from '../shared';
import {
  type EventWithType,
  KNOWN_EVENT_TYPES,
  KNOWN_PART_TYPES,
  readStringField,
} from './utils';
import {
  captureQuestionProxyIfNeeded,
  handlePermissionRepliedEvent,
  handlePermissionUpdatedEvent,
  handleQuestionAskedEvent,
  handleQuestionRejectedEvent,
  handleQuestionRepliedEvent,
  resetInteractionState,
} from './interaction';
import type { EventFlowDeps, EventMessageBuffer } from './types';
export type { EventFlowDeps } from './types';

const ROUTE_MISS_WARN_INTERVAL_MS = 30_000;
const MAX_ACTIVE_MESSAGE_BUFFERS = 600;
const BUFFER_SWEEP_BATCH_SIZE = 120;
const lastRouteMissWarnAt = new LRUCache<string, number>({ max: 4000, ttl: 10 * 60 * 1000 });
const forwardedSchedulerUserParts = new LRUCache<string, true>({ max: 8000, ttl: 20 * 60 * 1000 });

function clearAllPendingQuestions(deps: EventFlowDeps) {
  for (const timer of deps.pendingQuestionTimers.values()) {
    clearTimeout(timer);
  }
  deps.pendingQuestionTimers.clear();
  deps.chatPendingQuestion.clear();
}

function clearAllPendingAuthorizations(deps: EventFlowDeps) {
  for (const timer of deps.pendingAuthorizationTimers.values()) {
    clearTimeout(timer);
  }
  deps.pendingAuthorizationTimers.clear();
  deps.chatPendingAuthorization.clear();
}

function pruneMessageBuffers(deps: EventFlowDeps) {
  if (deps.msgBuffers.size <= MAX_ACTIVE_MESSAGE_BUFFERS) return;

  const activeMessageIds = new Set<string>();
  for (const mid of deps.sessionActiveMsg.values()) activeMessageIds.add(mid);

  let removed = 0;
  for (const [mid, buf] of deps.msgBuffers.entries()) {
    if (deps.msgBuffers.size <= MAX_ACTIVE_MESSAGE_BUFFERS) break;
    if (removed >= BUFFER_SWEEP_BATCH_SIZE) break;
    if (activeMessageIds.has(mid)) continue;
    if (buf.status === 'streaming') continue;
    deps.msgBuffers.delete(mid);
    deps.msgRole.delete(mid);
    removed++;
  }

  if (removed > 0) {
    bridgeLogger.debug(
      `[BridgeFlow] pruned message buffers removed=${removed} remaining=${deps.msgBuffers.size}`
    );
  }
}

function getCacheKeyBySession(
  sessionId: string,
  deps: EventFlowDeps
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
    `[BridgeFlow] route.miss event=${eventType} sid=${sessionId} mid=${
      messageId || '-'
    } (session has no chat mapping in memory)`
  );
}

function hydrateSessionRouteFromMetadata(
  sessionId: string,
  metadata: unknown,
  deps: EventFlowDeps
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
      `[BridgeFlow] hydrated-session-route sid=${sessionId} adapter=${adapterKey} chat=${chatId}`
    );
  }
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
  buffer: EventMessageBuffer
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
  force = false
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

export async function flushAllEvents(mux: AdapterMux, deps: EventFlowDeps) {
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
  deps: EventFlowDeps
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
      markStatus(deps.msgBuffers, mid, 'aborted', extractErrorMessage(info.error) || 'aborted');
    } else if (isOutputLengthError(info.error)) {
      markStatus(deps.msgBuffers, mid, 'error', 'output too long');
    } else if (isApiError(info.error)) {
      markStatus(deps.msgBuffers, mid, 'error', extractErrorMessage(info.error) || 'api error');
    } else {
      markStatus(
        deps.msgBuffers,
        mid,
        'error',
        extractErrorMessage(info.error) || info.error?.name || 'error'
      );
    }
    await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
    return;
  }

  if (info.finish || info.time?.completed) {
    markStatus(deps.msgBuffers, mid, 'done', info.finish || 'completed');
    await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
    pruneMessageBuffers(deps);
  }
}

async function handleMessagePartUpdatedEvent(
  event: EventMessagePartUpdated,
  api: OpencodeClient,
  mux: AdapterMux,
  deps: EventFlowDeps
) {
  const part = event.properties.part;
  const delta: string | undefined = event.properties.delta;

  const sessionId = part.sessionID;
  const messageId = part.messageID;
  if (!sessionId || !messageId) return;

  const partType = (part as { type?: unknown }).type;
  if (typeof partType === 'string' && !KNOWN_PART_TYPES.has(partType)) {
    bridgeLogger.warn(
      `[BridgeFlow] part.unknown sid=${sessionId} mid=${messageId} pid=${part.id || '-'} type=${partType}`
    );
  }

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
    if (forwardedSchedulerUserParts.get(dedupeKey)) {
      return;
    }
    forwardedSchedulerUserParts.set(dedupeKey, true);
    await adapter.sendMessage(ctx.chatId, part.text).catch(() => {});
    bridgeLogger.info(
      `[BridgeFlow] scheduler-user-part-forwarded sid=${sessionId} mid=${messageId} chat=${ctx.chatId}`
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
        `${FLOW_LOG_PREFIX} carry-execution sid=${sessionId} prev=${prev} next=${messageId}`
      );
    } else {
      bridgeLogger.debug(
        `[BridgeFlowDebug] do-not-carry sid=${sessionId} prev=${prev} next=${messageId} prevPlatform=${
          prevBuf?.platformMsgId || '-'
        } prevTextLen=${(prevBuf?.text || '').length} prevReasoningLen=${
          (prevBuf?.reasoning || '').length
        } prevTools=${prevBuf?.tools?.size || 0}`
      );
      markStatus(deps.msgBuffers, prev, 'done');
      await flushMessage(adapter, ctx.chatId, prev, deps.msgBuffers, true);
      pruneMessageBuffers(deps);
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
    `[BridgeFlowDebug] part-applied sid=${sessionId} mid=${messageId} part=${part.type} textLen=${
      buffer.text.length
    } reasoningLen=${buffer.reasoning.length} tools=${buffer.tools.size} status=${
      buffer.status
    } note="${buffer.statusNote || ''}" hasPlatform=${!!buffer.platformMsgId}`
  );

  if (shouldSplitOutFinalAnswer(buffer)) {
    bridgeLogger.info(
      `${FLOW_LOG_PREFIX} split-final-answer sid=${sessionId} mid=${messageId} textLen=${buffer.text.length}`
    );
    await finalizeExecutionCardBeforeSplit(adapter, ctx.chatId, buffer);
    splitFinalAnswerFromExecution(buffer);
  }

  if (part.type === 'step-finish' && buffer.status === 'streaming') {
    markStatus(deps.msgBuffers, messageId, 'done', part.reason || 'step-finish');
    pruneMessageBuffers(deps);
  }

  if (!shouldFlushNow(buffer, adapterKey || undefined)) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] skip-flush sid=${sessionId} mid=${messageId} reason=throttle`
    );
    return;
  }
  const hasAny = buffer.reasoning.length > 0 || buffer.text.length > 0 || buffer.tools.size > 0;
  if (!hasAny) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] skip-flush sid=${sessionId} mid=${messageId} reason=empty`
    );
    return;
  }

  buffer.lastUpdateTime = Date.now();

  const display = buildPlatformDisplay(buffer);
  const hash = simpleHash(display);
  if (buffer.platformMsgId && hash === buffer.lastDisplayHash) {
    bridgeLogger.debug(
      `[BridgeFlowDebug] skip-flush sid=${sessionId} mid=${messageId} reason=same-hash`
    );
    return;
  }

  if (!buffer.platformMsgId) {
    bridgeLogger.info(
      `${FLOW_LOG_PREFIX} send-new sid=${sessionId} mid=${messageId} tools=${buffer.tools.size}`
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
      `[BridgeFlowDebug] edited sid=${sessionId} mid=${messageId} msg=${ok} contentLen=${display.length}`
    );
    buffer.platformMsgId = ok;
    buffer.lastDisplayHash = hash;
  } else {
    bridgeLogger.warn(
      `[BridgeFlowDebug] edit-failed sid=${sessionId} mid=${messageId} msg=${buffer.platformMsgId} contentLen=${display.length}`
    );
  }
}

async function handleSessionErrorEvent(
  event: EventSessionError,
  mux: AdapterMux,
  deps: EventFlowDeps
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
    markStatus(deps.msgBuffers, mid, 'aborted', extractErrorMessage(err) || 'aborted');
  } else {
    markStatus(
      deps.msgBuffers,
      mid,
      'error',
      extractErrorMessage(err) || err?.name || 'session.error'
    );
  }
  const errMsg = extractErrorMessage(err) || '-';
  bridgeLogger.warn(
    `[BridgeFlow] session-error sid=${sid} mid=${mid} name=${err?.name || '-'} msg=${errMsg}`
  );
  await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
  pruneMessageBuffers(deps);
}

async function handleSessionIdleEvent(
  event: EventSessionIdle,
  mux: AdapterMux,
  deps: EventFlowDeps
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
    pruneMessageBuffers(deps);
    return;
  }
  markStatus(deps.msgBuffers, mid, 'done', 'idle');
  await flushMessage(adapter, ctx.chatId, mid, deps.msgBuffers, true);
  pruneMessageBuffers(deps);
}

function handleCommandExecutedEvent(event: EventCommandExecuted, deps: EventFlowDeps) {
  const mid = event.properties.messageID;
  if (!mid) return;
  const buf = getOrInitBuffer(deps.msgBuffers, mid);
  buf.isCommand = true;
}

function handleMessageRemovedEvent(event: EventWithType, deps: EventFlowDeps) {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionID = readStringField(props, 'sessionID');
  const messageID = readStringField(props, 'messageID');
  if (!sessionID || !messageID) return;
  deps.msgBuffers.delete(messageID);
  deps.msgRole.delete(messageID);
  if (deps.sessionActiveMsg.get(sessionID) === messageID) {
    deps.sessionActiveMsg.delete(sessionID);
  }
  bridgeLogger.debug(`[BridgeFlow] message.removed sid=${sessionID} mid=${messageID}`);
}

function handleMessagePartRemovedEvent(event: EventWithType) {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionID = readStringField(props, 'sessionID');
  const messageID = readStringField(props, 'messageID');
  const partID = readStringField(props, 'partID');
  if (!sessionID || !messageID || !partID) return;
  bridgeLogger.debug(`[BridgeFlow] message.part.removed sid=${sessionID} mid=${messageID} pid=${partID}`);
}

function handleSessionStatusEvent(event: EventWithType, deps: EventFlowDeps) {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionID = readStringField(props, 'sessionID');
  if (!sessionID) return;
  const statusObj =
    props.status && typeof props.status === 'object'
      ? (props.status as Record<string, unknown>)
      : undefined;
  const statusType = readStringField(statusObj || {}, 'type');
  if (!statusType) return;

  const mid = deps.sessionActiveMsg.get(sessionID);
  if (!mid) return;
  const buf = deps.msgBuffers.get(mid);
  if (!buf || buf.status !== 'streaming') return;

  if (statusType === 'retry') {
    const retryMsg = readStringField(statusObj || {}, 'message');
    buf.statusNote = retryMsg ? `retry: ${retryMsg}` : 'retry';
    return;
  }

  if (statusType === 'busy') {
    buf.statusNote = 'busy';
  }
}

export async function dispatchEventByType(
  e: EventWithType,
  api: OpencodeClient,
  mux: AdapterMux,
  deps: EventFlowDeps
): Promise<void> {
  if (e.type === 'message.updated') {
    await handleMessageUpdatedEvent(e as EventMessageUpdated, mux, deps);
    return;
  }

  if (e.type === 'message.part.updated') {
    const pe = e as EventMessagePartUpdated;
    const p = pe.properties.part;
    bridgeLogger.debug(
      `[BridgeFlowDebug] part.updated sid=${p.sessionID} mid=${p.messageID} type=${p.type} deltaLen=${(pe.properties.delta || '').length}`
    );
    await handleMessagePartUpdatedEvent(pe, api, mux, deps);
    return;
  }

  if (e.type === 'session.error') {
    await handleSessionErrorEvent(e as EventSessionError, mux, deps);
    return;
  }

  if (e.type === 'session.idle') {
    await handleSessionIdleEvent(e as EventSessionIdle, mux, deps);
    return;
  }

  if (e.type === 'permission.updated' || e.type === 'permission.asked') {
    await handlePermissionUpdatedEvent(e as EventPermissionUpdated, mux, deps, warnRouteMissOnce);
    return;
  }

  if (e.type === 'permission.replied') {
    await handlePermissionRepliedEvent(e as EventPermissionReplied, mux, deps);
    return;
  }

  if (e.type === 'command.executed') {
    handleCommandExecutedEvent(e as EventCommandExecuted, deps);
    return;
  }

  if (e.type === 'message.removed') {
    handleMessageRemovedEvent(e, deps);
    return;
  }

  if (e.type === 'message.part.removed') {
    handleMessagePartRemovedEvent(e);
    return;
  }

  if (e.type === 'session.status') {
    handleSessionStatusEvent(e, deps);
    return;
  }

  if (e.type === 'question.asked') {
    await handleQuestionAskedEvent(e, mux, deps);
    return;
  }

  if (e.type === 'question.replied') {
    await handleQuestionRepliedEvent(e, mux, deps);
    return;
  }

  if (e.type === 'question.rejected') {
    await handleQuestionRejectedEvent(e, mux, deps);
    return;
  }

  if (KNOWN_EVENT_TYPES.has(e.type)) {
    bridgeLogger.debug(`[BridgeFlow] event.unhandled type=${e.type}`);
    return;
  }

  bridgeLogger.warn(`[BridgeFlow] event.unknown type=${e.type}`);
}

export function resetEventDispatchState(deps: EventFlowDeps) {
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
  clearAllPendingAuthorizations(deps);
  lastRouteMissWarnAt.clear();
  forwardedSchedulerUserParts.clear();
  resetInteractionState();
}
