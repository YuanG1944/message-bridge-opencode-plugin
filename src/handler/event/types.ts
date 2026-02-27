import type { MessageBuffer } from '../../bridge/buffer';
import type { PendingAuthorizationState, PendingQuestionState } from '../proxy';

export type SessionContext = { chatId: string; senderId: string };
export type SelectedModel = { providerID: string; modelID: string; name?: string };
export type ListenerState = { isListenerStarted: boolean; shouldStopListener: boolean };
export type EventMessageBuffer = MessageBuffer & { __executionCarried?: boolean };

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
  chatPendingAuthorization: Map<string, PendingAuthorizationState>;
  pendingQuestionTimers: Map<string, NodeJS.Timeout>;
  pendingAuthorizationTimers: Map<string, NodeJS.Timeout>;
  sessionReplyWatchdogTimers: Map<string, NodeJS.Timeout>;
  isQuestionCallHandled: (cacheKey: string, messageId: string, callID: string) => boolean;
  markQuestionCallHandled: (cacheKey: string, messageId: string, callID: string) => void;
};
