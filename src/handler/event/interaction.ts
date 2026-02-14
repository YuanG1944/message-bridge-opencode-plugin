import type { EventPermissionReplied, EventPermissionUpdated, OpencodeClient, ToolPart } from '@opencode-ai/sdk';
import { LRUCache } from 'lru-cache';
import { bridgeLogger } from '../../logger';
import type { AdapterMux } from '../mux';
import {
  AUTH_TIMEOUT_MS,
  extractQuestionPayload,
  isQuestionToolPart,
  QUESTION_TIMEOUT_MS,
  renderAuthorizationPrompt,
  renderQuestionPrompt,
} from '../proxy';
import type { NormalizedQuestionPayload, PendingAuthorizationState, PendingQuestionState } from '../proxy';
import { readStringField, type EventWithType } from './utils';
import type { EventFlowDeps } from './types';

const PERMISSION_DEDUPE_WINDOW_MS = 3_000;
const PERMISSION_PROMPT_DEDUPE_WINDOW_MS = 30_000;
const recentPermissionEventAt = new LRUCache<string, number>({
  max: 6000,
  ttl: PERMISSION_DEDUPE_WINDOW_MS * 4,
});
const recentPermissionPromptBySession = new LRUCache<string, { at: number; signature: string }>({
  max: 2000,
  ttl: PERMISSION_PROMPT_DEDUPE_WINDOW_MS * 4,
});

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

function hydrateSessionRouteFromEventProps(
  sessionId: string,
  props: Record<string, unknown>,
  deps: EventFlowDeps
): boolean {
  const candidates: Array<Record<string, unknown>> = [props];
  const route =
    props.route && typeof props.route === 'object' ? (props.route as Record<string, unknown>) : undefined;
  if (route) candidates.push(route);
  const metadata =
    props.metadata && typeof props.metadata === 'object'
      ? (props.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) candidates.push(metadata);
  const metadataRoute =
    metadata?.route && typeof metadata.route === 'object'
      ? (metadata.route as Record<string, unknown>)
      : undefined;
  if (metadataRoute) candidates.push(metadataRoute);
  const tool =
    props.tool && typeof props.tool === 'object' ? (props.tool as Record<string, unknown>) : undefined;
  if (tool) candidates.push(tool);

  let chatId = '';
  let adapterKey = '';
  for (const c of candidates) {
    if (!chatId) chatId = readStringField(c, 'chat_id', 'chatId') || '';
    if (!adapterKey) adapterKey = readStringField(c, 'adapter_key', 'adapterKey', 'adapter') || '';
    if (chatId && adapterKey) break;
  }
  if (!chatId || !adapterKey) return false;

  const existingCtx = deps.sessionToCtx.get(sessionId);
  const existingAdapter = deps.sessionToAdapterKey.get(sessionId);
  if (!existingCtx) {
    const senderId =
      readStringField(props, 'sender_id', 'senderId') ||
      readStringField(route || {}, 'sender_id', 'senderId') ||
      'system';
    deps.sessionToCtx.set(sessionId, { chatId, senderId });
  }
  if (!existingAdapter) {
    deps.sessionToAdapterKey.set(sessionId, adapterKey);
  }
  return true;
}

function clearPendingQuestionForChat(deps: EventFlowDeps, cacheKey: string) {
  const timer = deps.pendingQuestionTimers.get(cacheKey);
  if (timer) {
    clearTimeout(timer);
    deps.pendingQuestionTimers.delete(cacheKey);
  }
  deps.chatPendingQuestion.delete(cacheKey);
}

function clearPendingAuthorizationForChat(deps: EventFlowDeps, cacheKey: string) {
  const timer = deps.pendingAuthorizationTimers.get(cacheKey);
  if (timer) {
    clearTimeout(timer);
    deps.pendingAuthorizationTimers.delete(cacheKey);
  }
  deps.chatPendingAuthorization.delete(cacheKey);
}

function shouldSkipDuplicatePermissionEvent(scope: 'request' | 'reply', sid: string, id: string): boolean {
  const now = Date.now();
  const key = `${scope}:${sid}:${id}`;
  const last = recentPermissionEventAt.get(key);
  recentPermissionEventAt.set(key, now);
  return typeof last === 'number' && now - last < PERMISSION_DEDUPE_WINDOW_MS;
}

function permissionSignature(input: {
  type?: string;
  title?: string;
  pattern?: string | Array<string>;
  callID?: string;
}): string {
  const patternText = Array.isArray(input.pattern) ? input.pattern.join('|') : (input.pattern || '');
  return [input.type || '', input.title || '', patternText, input.callID || ''].join('::');
}

async function armPendingQuestionPrompt(params: {
  sessionId: string;
  messageId: string;
  callID: string;
  payload: NormalizedQuestionPayload;
  mux: AdapterMux;
  deps: EventFlowDeps;
}): Promise<boolean> {
  const { sessionId, messageId, callID, payload, mux, deps } = params;
  const sessionCtx = getCacheKeyBySession(sessionId, deps);
  if (!sessionCtx) return false;
  const { cacheKey, adapterKey, chatId } = sessionCtx;

  if (deps.isQuestionCallHandled(cacheKey, messageId, callID)) return false;
  const existing = deps.chatPendingQuestion.get(cacheKey);
  if (existing && existing.callID === callID && existing.messageId === messageId) return true;

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
  bridgeLogger.info(
    `[QuestionFlow] pending-set sid=${sessionId} mid=${messageId} call=${callID} count=${payload.questions.length} shape=${payload.questions
      .map(q => `${q.id}:${q.freeText ? 'text' : 'option'}:${q.options.length}`)
      .join('|')}`,
  );

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

export async function captureQuestionProxyIfNeeded(params: {
  part: ToolPart;
  sessionId: string;
  messageId: string;
  api: OpencodeClient;
  mux: AdapterMux;
  deps: EventFlowDeps;
}): Promise<boolean> {
  const { part, sessionId, messageId, mux, deps } = params;
  if (!isQuestionToolPart(part)) return false;

  const payloadMaybe =
    extractQuestionPayload(part?.state?.input) ||
    extractQuestionPayload((part?.state?.input as Record<string, unknown> | undefined)?.questions) ||
    extractQuestionPayload((part?.state?.input as Record<string, unknown> | undefined)?.question);
  const fallbackPayload =
    payloadMaybe ||
    extractQuestionPayload([
      {
        id: part.callID || `q-${messageId}`,
        question:
          readStringField((part?.state?.input as Record<string, unknown> | undefined) || {}, 'question', 'prompt', 'title', 'text') ||
          '检测到网页侧需要额外输入，请直接回复要填写的内容。',
        freeText: true,
      },
    ]);
  if (fallbackPayload === null) return false;
  if (payloadMaybe === null) {
    bridgeLogger.warn(
      `[BridgeFlow] question.tool parse-fallback sid=${sessionId} mid=${messageId} callID=${part.callID || '-'}`,
    );
  }
  const callID = part.callID || `question-${messageId}`;
  return armPendingQuestionPrompt({
    sessionId,
    messageId,
    callID,
    payload: fallbackPayload,
    mux,
    deps,
  });
}

export async function handleQuestionAskedEvent(
  event: EventWithType,
  mux: AdapterMux,
  deps: EventFlowDeps
): Promise<void> {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionId = readStringField(props, 'sessionID', 'sessionId');
  if (!sessionId) return;
  hydrateSessionRouteFromEventProps(sessionId, props, deps);

  const payloadMaybe =
    extractQuestionPayload(props.questions) ||
    extractQuestionPayload(props.question) ||
    extractQuestionPayload(props.input) ||
    extractQuestionPayload(props);
  if (!payloadMaybe) {
    const fallbackQuestion =
      readStringField(props, 'question', 'prompt', 'title', 'text') ||
      '检测到网页侧需要额外输入，请直接回复要填写的内容。';
    const fallbackPayload = extractQuestionPayload([
      {
        id: readStringField(props, 'id', 'requestID', 'callID') || `q-${Date.now()}`,
        question: fallbackQuestion,
        freeText: true,
      },
    ]);
    if (fallbackPayload) {
      const toolFallback =
        props.tool && typeof props.tool === 'object'
          ? (props.tool as Record<string, unknown>)
          : undefined;
      const fallbackMessageId =
        readStringField(toolFallback || {}, 'messageID', 'messageId') ||
        readStringField(props, 'messageID', 'messageId') ||
        `question-${sessionId}`;
      const fallbackCallID =
        readStringField(toolFallback || {}, 'callID', 'callId') ||
        readStringField(props, 'id', 'requestID', 'requestId') ||
        `question-${fallbackMessageId}`;
      bridgeLogger.warn(
        `[BridgeFlow] question.asked parse-fallback sid=${sessionId} callID=${fallbackCallID} mid=${fallbackMessageId}`,
      );
      await armPendingQuestionPrompt({
        sessionId,
        messageId: fallbackMessageId,
        callID: fallbackCallID,
        payload: fallbackPayload,
        mux,
        deps,
      });
      return;
    }

    const firstQuestion =
      Array.isArray(props.questions) &&
      props.questions.length > 0 &&
      typeof props.questions[0] === 'object' &&
      props.questions[0] !== null
        ? (props.questions[0] as Record<string, unknown>)
        : undefined;
    const firstQuestionKeys = firstQuestion ? Object.keys(firstQuestion).slice(0, 12).join(',') : '-';
    bridgeLogger.warn(
      `[BridgeFlow] question.asked ignored sid=${sessionId} reason=invalid-payload questions=${Array.isArray(props.questions) ? props.questions.length : 0} propKeys=${Object.keys(
        props,
      )
        .slice(0, 20)
        .join(',')} firstQuestionKeys=${firstQuestionKeys}`
    );
    return;
  }

  const tool =
    props.tool && typeof props.tool === 'object'
      ? (props.tool as Record<string, unknown>)
      : undefined;
  const messageId =
    readStringField(tool || {}, 'messageID', 'messageId') ||
    readStringField(props, 'messageID', 'messageId') ||
    `question-${sessionId}`;
  const callID =
    readStringField(tool || {}, 'callID', 'callId') ||
    readStringField(props, 'id', 'requestID', 'requestId') ||
    `question-${messageId}`;

  await armPendingQuestionPrompt({
    sessionId,
    messageId,
    callID,
    payload: payloadMaybe,
    mux,
    deps,
  });
}

export async function handlePermissionUpdatedEvent(
  event: EventPermissionUpdated | EventWithType,
  mux: AdapterMux,
  deps: EventFlowDeps,
  warnRouteMissOnce: (eventType: string, sessionId: string, messageId?: string) => void
) {
  const permission = (event.properties || {}) as Record<string, unknown>;
  const sessionId = readStringField(permission, 'sessionID', 'sessionId');
  if (sessionId) {
    hydrateSessionRouteFromEventProps(sessionId, permission, deps);
  }
  const permissionID = readStringField(
    permission,
    'id',
    'permissionID',
    'permissionId',
    'requestID',
    'requestId',
  );
  const permissionType = readStringField(permission, 'type', 'permission');
  const permissionTitle = readStringField(permission, 'title') || permissionType || '权限请求';
  const permissionPattern =
    permission.pattern ??
    (Array.isArray(permission.patterns) ? permission.patterns : undefined);
  const tool =
    permission.tool && typeof permission.tool === 'object'
      ? (permission.tool as Record<string, unknown>)
      : undefined;
  const callID =
    readStringField(permission, 'callID', 'callId') || readStringField(tool || {}, 'callID', 'callId');

  if (!sessionId) return;
  if (!permissionID) {
    bridgeLogger.warn(
      `[BridgePermission] missing permissionID sid=${sessionId} type=${permissionType || '-'} title=${(permissionTitle || '').slice(0, 160)}`,
    );
    const route = getCacheKeyBySession(sessionId, deps);
    if (!route) {
      warnRouteMissOnce((event.type as string) || 'permission.updated', sessionId);
      return;
    }
    const { cacheKey, adapterKey, chatId } = route;
    const adapter = mux.get(adapterKey);
    if (!adapter) return;
    const ctx = deps.sessionToCtx.get(sessionId);
    if (!ctx) return;

    clearPendingAuthorizationForChat(deps, cacheKey);
    const pending: PendingAuthorizationState = {
      mode: 'session_blocked',
      key: cacheKey,
      adapterKey,
      chatId,
      senderId: ctx.senderId,
      sessionId,
      blockedReason: permissionTitle || permissionType || '需要网页侧授权',
      source: 'bridge.incoming',
      createdAt: Date.now(),
      dueAt: Date.now() + AUTH_TIMEOUT_MS,
    };
    deps.chatPendingAuthorization.set(cacheKey, pending);
    const timer = setTimeout(async () => {
      const current = deps.chatPendingAuthorization.get(cacheKey);
      if (!current || current.sessionId !== sessionId || current.mode !== 'session_blocked') return;
      clearPendingAuthorizationForChat(deps, cacheKey);
      await adapter.sendMessage(chatId, '## Status\n⏰ 授权等待已超时。').catch(() => {});
    }, AUTH_TIMEOUT_MS);
    deps.pendingAuthorizationTimers.set(cacheKey, timer);
    await adapter.sendMessage(chatId, renderAuthorizationPrompt(pending)).catch(() => {});
    return;
  }
  if (shouldSkipDuplicatePermissionEvent('request', sessionId, permissionID)) {
    bridgeLogger.debug(
      `[BridgePermission] dedupe skip request sid=${sessionId} permissionID=${permissionID}`
    );
    return;
  }
  bridgeLogger.info(
    `[BridgePermission] updated sid=${sessionId} permissionID=${permissionID} type=${permissionType || '-'} callID=${callID || '-'} title=${(permissionTitle || '').slice(0, 160)} pattern=${Array.isArray(permissionPattern) ? permissionPattern.join('|') : ((permissionPattern as string) || '-')}`
  );

  const route = getCacheKeyBySession(sessionId, deps);
  if (!route) {
    warnRouteMissOnce((event.type as string) || 'permission.updated', sessionId);
    return;
  }
  const { cacheKey, adapterKey, chatId } = route;
  const adapter = mux.get(adapterKey);
  if (!adapter) return;
  const ctx = deps.sessionToCtx.get(sessionId);
  if (!ctx) return;

  const existingPending = deps.chatPendingAuthorization.get(cacheKey);
  if (
    existingPending &&
    existingPending.mode === 'permission_request' &&
    existingPending.sessionId === sessionId
  ) {
    existingPending.permissionID = permissionID;
    existingPending.permissionType = permissionType;
    existingPending.permissionTitle = permissionTitle;
    existingPending.permissionPattern = permissionPattern as string | Array<string> | undefined;
    existingPending.blockedReason = permissionTitle;
    deps.chatPendingAuthorization.set(cacheKey, existingPending);
    bridgeLogger.debug(
      `[BridgePermission] update pending without re-prompt sid=${sessionId} permissionID=${permissionID}`
    );
    return;
  }

  const sig = permissionSignature({
    type: permissionType,
    title: permissionTitle,
    pattern: permissionPattern as string | Array<string> | undefined,
    callID,
  });
  const prevPrompt = recentPermissionPromptBySession.get(cacheKey);
  const now = Date.now();
  if (
    prevPrompt &&
    prevPrompt.signature === sig &&
    now - prevPrompt.at < PERMISSION_PROMPT_DEDUPE_WINDOW_MS
  ) {
    const pending = deps.chatPendingAuthorization.get(cacheKey);
    if (pending && pending.mode === 'permission_request') {
      pending.permissionID = permissionID;
      pending.permissionType = permissionType;
      pending.permissionTitle = permissionTitle;
      pending.permissionPattern = permissionPattern as string | Array<string> | undefined;
      deps.chatPendingAuthorization.set(cacheKey, pending);
    }
    bridgeLogger.debug(
      `[BridgePermission] dedupe skip prompt sid=${sessionId} permissionID=${permissionID} sig=${sig}`
    );
    return;
  }
  recentPermissionPromptBySession.set(cacheKey, { at: now, signature: sig });

  clearPendingAuthorizationForChat(deps, cacheKey);
  const pending: PendingAuthorizationState = {
    mode: 'permission_request',
    key: cacheKey,
    adapterKey,
    chatId,
    senderId: ctx.senderId,
    sessionId,
    permissionID,
    permissionType,
    permissionTitle,
    permissionPattern: permissionPattern as string | Array<string> | undefined,
    blockedReason: permissionTitle,
    source: 'bridge.incoming',
    createdAt: Date.now(),
    dueAt: Date.now() + AUTH_TIMEOUT_MS,
  };
  deps.chatPendingAuthorization.set(cacheKey, pending);

  const timer = setTimeout(async () => {
    const current = deps.chatPendingAuthorization.get(cacheKey);
    if (!current || current.permissionID !== permissionID) return;
    clearPendingAuthorizationForChat(deps, cacheKey);
    await adapter.sendMessage(chatId, '## Status\n⏰ 权限请求已超时未处理。').catch(() => {});
  }, AUTH_TIMEOUT_MS);
  deps.pendingAuthorizationTimers.set(cacheKey, timer);

  await adapter.sendMessage(chatId, renderAuthorizationPrompt(pending)).catch(() => {});
}

export async function handlePermissionRepliedEvent(
  event: EventPermissionReplied,
  mux: AdapterMux,
  deps: EventFlowDeps
) {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionId = readStringField(props, 'sessionID', 'sessionId');
  if (!sessionId) return;
  const permissionID = readStringField(
    props,
    'permissionID',
    'permissionId',
    'requestID',
    'requestId',
  ) || '';
  const response = readStringField(props, 'response', 'reply') || '-';
  if (permissionID && shouldSkipDuplicatePermissionEvent('reply', sessionId, permissionID)) {
    bridgeLogger.debug(
      `[BridgePermission] dedupe skip reply sid=${sessionId} permissionID=${permissionID} response=${response}`
    );
    return;
  }
  bridgeLogger.info(
    `[BridgePermission] replied sid=${sessionId} permissionID=${permissionID || '-'} response=${response}`
  );
  const route = getCacheKeyBySession(sessionId, deps);
  if (!route) return;
  const { cacheKey, adapterKey, chatId } = route;
  const pending = deps.chatPendingAuthorization.get(cacheKey);
  if (!pending || pending.mode !== 'permission_request') return;
  if (!pending.permissionID || pending.permissionID !== permissionID) return;
  clearPendingAuthorizationForChat(deps, cacheKey);
  const adapter = mux.get(adapterKey);
  if (!adapter) return;
  const label =
    response === 'always'
      ? '✅ 权限已设置为始终允许。'
      : response === 'once'
        ? '✅ 权限已允许一次，继续处理中。'
        : '⚠️ 权限已拒绝。';
  await adapter.sendMessage(chatId, `## Status\n${label}`).catch(() => {});
}

function findPendingQuestionBySession(
  deps: EventFlowDeps,
  sessionId: string,
  callIdOrRequestId?: string
): { cacheKey: string; pending: PendingQuestionState } | null {
  for (const [cacheKey, pending] of deps.chatPendingQuestion.entries()) {
    if (pending.sessionId !== sessionId) continue;
    if (!callIdOrRequestId || pending.callID === callIdOrRequestId) {
      return { cacheKey, pending };
    }
  }
  return null;
}

export async function handleQuestionRepliedEvent(
  event: EventWithType,
  mux: AdapterMux,
  deps: EventFlowDeps
) {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionId = readStringField(props, 'sessionID', 'sessionId');
  const requestId = readStringField(props, 'requestID', 'requestId');
  if (!sessionId) return;

  const hit = findPendingQuestionBySession(deps, sessionId, requestId);
  if (!hit) return;
  const { cacheKey, pending } = hit;
  clearPendingQuestionForChat(deps, cacheKey);
  deps.markQuestionCallHandled(cacheKey, pending.messageId, pending.callID);

  const adapter = mux.get(pending.adapterKey);
  if (!adapter) return;
  await adapter.sendMessage(pending.chatId, '## Status\n✅ 已收到问题选项，继续处理中。').catch(() => {});
}

export async function handleQuestionRejectedEvent(
  event: EventWithType,
  mux: AdapterMux,
  deps: EventFlowDeps
) {
  const props = (event.properties || {}) as Record<string, unknown>;
  const sessionId = readStringField(props, 'sessionID', 'sessionId');
  const requestId = readStringField(props, 'requestID', 'requestId');
  if (!sessionId) return;

  const hit = findPendingQuestionBySession(deps, sessionId, requestId);
  if (!hit) return;
  const { cacheKey, pending } = hit;
  clearPendingQuestionForChat(deps, cacheKey);
  deps.markQuestionCallHandled(cacheKey, pending.messageId, pending.callID);

  const adapter = mux.get(pending.adapterKey);
  if (!adapter) return;
  await adapter
    .sendMessage(pending.chatId, '## Status\n⚠️ 本轮问题选择已被取消，请重新发起。')
    .catch(() => {});
}

export function resetInteractionState(): void {
  recentPermissionEventAt.clear();
  recentPermissionPromptBySession.clear();
}
