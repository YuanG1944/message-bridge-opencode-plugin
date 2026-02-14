import type { FilePartInput, OpencodeClient, TextPartInput } from '@opencode-ai/sdk';
import type { BridgeAdapter } from '../../types';
import { LOADING_EMOJI } from '../../constants';
import { drainPendingFileParts, saveFilePartToLocal } from '../../bridge/file.store';
import { ERROR_HEADER, parseSlashCommand, globalState } from '../../utils';
import { bridgeLogger } from '../../logger';
import { handleSlashCommand } from '../command';
import type { AdapterMux } from '../mux';
import {
  AUTH_TIMEOUT_MS,
  buildResumePrompt,
  parseAuthorizationReply,
  parseUserReply,
  renderAuthorizationPrompt,
  renderAuthorizationReplyHint,
  renderAuthorizationStatus,
  renderAnswerSummary,
  renderReplyHint,
} from '../proxy';
import type { PendingAuthorizationState, PendingQuestionState } from '../proxy';
import {
  extractErrorMessage,
  isRecord,
  readString,
  toApiArray,
  toApiRecord,
} from '../shared';

type SessionContext = { chatId: string; senderId: string };
type SelectedModel = { providerID: string; modelID: string; name?: string };
type NamedRecord = { id?: string; name?: string; title?: string; description?: string };
const DEFAULT_AGENT_ID = 'build';

function asArray<T>(value: unknown, map: (item: unknown) => T | null): T[] {
  return toApiArray(value).map(map).filter((v): v is T => v !== null);
}

function toNamedRecord(item: unknown): NamedRecord | null {
  if (!isRecord(item)) return null;
  return {
    id: typeof item.id === 'string' ? item.id : undefined,
    name: typeof item.name === 'string' ? item.name : undefined,
    title: typeof item.title === 'string' ? item.title : undefined,
    description: typeof item.description === 'string' ? item.description : undefined,
  };
}

function isFilePartInput(part: TextPartInput | FilePartInput): part is FilePartInput {
  return part.type === 'file';
}

function normalizeSlashCommand(command?: string): string | undefined {
  if (!command) return command;
  const aliasMap: Record<string, string> = {
    resume: 'sessions',
    continue: 'sessions',
    summarize: 'compact',
    model: 'models',
    restart: 'restart',
    new: 'new',
    reset: 'restart',
  };

  return aliasMap[command] || command;
}

function buildBridgePartMetadata(input: {
  adapterKey: string;
  chatId: string;
  senderId: string;
  sessionId: string;
  source: 'bridge.incoming' | 'bridge.question.resume';
}) {
  return {
    bridge: true,
    source: input.source,
    adapter_key: input.adapterKey,
    chat_id: input.chatId,
    sender_id: input.senderId,
    session_id: input.sessionId,
    routed_at: new Date().toISOString(),
  } as const;
}

function isLikelyPermissionBlockedError(err: unknown): boolean {
  const msg = (extractErrorMessage(err) || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('permission') ||
    msg.includes('approval') ||
    msg.includes('approve') ||
    msg.includes('consent') ||
    msg.includes('authorize') ||
    msg.includes('confirm') ||
    msg.includes('busy') ||
    msg.includes('not idle') ||
    msg.includes('already running') ||
    msg.includes('in progress') ||
    msg.includes('会话忙') ||
    msg.includes('需要权限') ||
    msg.includes('等待授权') ||
    msg.includes('等待确认')
  );
}

export type IncomingFlowDeps = {
  sessionCache: Map<string, string>;
  sessionToAdapterKey: Map<string, string>;
  sessionToCtx: Map<string, SessionContext>;
  chatAgent: Map<string, string>;
  chatModel: Map<string, SelectedModel>;
  chatSessionList: Map<string, Array<{ id: string; title: string }>>;
  chatAgentList: Map<string, Array<{ id: string; name: string }>>;
  chatAwaitingSaveFile: Map<string, boolean>;
  chatMaxFileSizeMb: Map<string, number>;
  chatMaxFileRetry: Map<string, number>;
  chatPendingQuestion: Map<string, PendingQuestionState>;
  chatPendingAuthorization: Map<string, PendingAuthorizationState>;
  pendingAuthorizationTimers: Map<string, NodeJS.Timeout>;
  clearPendingQuestionForChat: (cacheKey: string) => void;
  clearPendingAuthorizationForChat: (cacheKey: string) => void;
  clearAllPendingAuthorizations: () => void;
  markQuestionCallHandled: (cacheKey: string, messageId: string, callID: string) => void;
  clearAllPendingQuestions: () => void;
  formatUserError: (err: unknown) => string;
};

export const createIncomingHandlerWithDeps = (
  api: OpencodeClient,
  mux: AdapterMux,
  adapterKey: string,
  deps: IncomingFlowDeps,
) => {
  const adapter = mux.get(adapterKey);
  if (!adapter) throw new Error(`[Handler] Adapter not found: ${adapterKey}`);

  return async (
    chatId: string,
    text: string,
    messageId: string,
    senderId: string,
    parts?: Array<TextPartInput | FilePartInput>,
  ) => {
    bridgeLogger.info(
      `[Incoming] adapter=${adapterKey} chat=${chatId} sender=${senderId} msg=${messageId} textLen=${text?.length || 0} parts=${parts?.length || 0}`,
    );

    const slash = parseSlashCommand(text);
    const hasText = Boolean(text && text.trim());
    const cacheKey = `${adapterKey}:${chatId}`;
    const rawCommand = slash?.command?.toLowerCase();
    const normalizedCommand = normalizeSlashCommand(rawCommand);
    const sessionsArg = slash?.arguments?.trim() || '';
    const targetSessionId =
      normalizedCommand === 'sessions' &&
      sessionsArg &&
      !/^(del|delete|rm|remove)\b/i.test(sessionsArg)
        ? sessionsArg.split(/\s+/)[0]
        : null;
    const targetAgentArg = slash?.arguments ? slash.arguments.trim() : '';
    const targetAgent = normalizedCommand === 'agent' && targetAgentArg ? targetAgentArg : null;
    const shouldCreateNew = normalizedCommand === 'new';

    if (!slash && text.trim().toLowerCase() === 'ping') {
      await adapter.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;
    let shouldClearProgressMsg = false;

    try {
      if (messageId && adapter.addReaction) {
        reactionId = await adapter.addReaction(messageId, LOADING_EMOJI);
      }

      const createNewSession = async () => {
        const previousAgent = deps.chatAgent.get(cacheKey);
        const previousModel = deps.chatModel.get(cacheKey);
        const uniqueTitle = `[${adapterKey}] Chat ${chatId.slice(
          -4,
        )} [${new Date().toLocaleTimeString()}]`;
        const res = await api.session.create({ body: { title: uniqueTitle } });
        const data = toApiRecord(res);
        const nestedSession = data ? toApiRecord(data.session) : null;
        const sessionId = readString(data, 'id') || readString(nestedSession, 'id');
        if (sessionId) {
          deps.sessionCache.set(cacheKey, sessionId);
          deps.sessionToAdapterKey.set(sessionId, adapterKey);
          deps.sessionToCtx.set(sessionId, { chatId, senderId });
          deps.chatAgent.set(cacheKey, previousAgent || DEFAULT_AGENT_ID);
          if (previousModel) deps.chatModel.set(cacheKey, previousModel);
          else deps.chatModel.delete(cacheKey);
        }
        return sessionId;
      };

      const ensureSession = async () => {
        let sessionId = deps.sessionCache.get(cacheKey);
        if (!sessionId) {
          sessionId = await createNewSession();
        }
        if (!sessionId) throw new Error('Failed to init Session');
        return sessionId;
      };

      const cloneParts = (items: Array<TextPartInput | FilePartInput>) =>
        items.map(part => {
          if (part.type === 'text') {
            return {
              ...part,
              ...(part.metadata && typeof part.metadata === 'object'
                ? { metadata: { ...(part.metadata as Record<string, unknown>) } }
                : {}),
            } as TextPartInput;
          }
          return { ...part } as FilePartInput;
        });

      const submitPrompt = async (
        sessionId: string,
        partList: Array<TextPartInput | FilePartInput>,
      ) => {
        const agent = deps.chatAgent.get(cacheKey);
        const model = deps.chatModel.get(cacheKey);
        await api.session.prompt({
          path: { id: sessionId },
          body: {
            parts: partList,
            ...(agent ? { agent } : {}),
            ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          },
        });
      };

      const armPendingAuthorization = async (
        sessionId: string,
        source: 'bridge.incoming' | 'bridge.question.resume',
        deferredParts: Array<TextPartInput | FilePartInput>,
        reason: string,
      ) => {
        deps.clearPendingAuthorizationForChat(cacheKey);

        const pending: PendingAuthorizationState = {
          mode: 'session_blocked',
          key: cacheKey,
          adapterKey,
          chatId,
          senderId,
          sessionId,
          blockedReason: reason || '需要网页权限确认',
          source,
          deferredParts: cloneParts(deferredParts),
          createdAt: Date.now(),
          dueAt: Date.now() + AUTH_TIMEOUT_MS,
        };

        deps.chatPendingAuthorization.set(cacheKey, pending);

        const timer = setTimeout(async () => {
          const current = deps.chatPendingAuthorization.get(cacheKey);
          if (!current || current.sessionId !== sessionId) return;
          deps.clearPendingAuthorizationForChat(cacheKey);
          await adapter.sendMessage(chatId, renderAuthorizationStatus('timeout')).catch(() => {});
        }, AUTH_TIMEOUT_MS);
        deps.pendingAuthorizationTimers.set(cacheKey, timer);

        await adapter.sendMessage(chatId, renderAuthorizationPrompt(pending)).catch(() => {});
      };

      const sendCommandMessage = async (content: string) => {
        const normalized = content.trimStart().startsWith('## Command')
          ? content
          : `## Command\n${content}`;
        await adapter.sendMessage(chatId, normalized);
      };

      const sendErrorMessage = async (content: string) => {
        await adapter.sendMessage(chatId, `${ERROR_HEADER}\n${content}`);
      };

      globalState.__bridge_send_error_message = async (cId: string, content: string) => {
        await adapter.sendMessage(cId, `${ERROR_HEADER}\n${content}`);
      };

      const sendUnsupported = async () => {
        await sendCommandMessage(`❌ 命令 /${slash?.command} 暂不支持在聊天中使用。`);
      };

      const sendLocalFile = async (filePath: string): Promise<boolean | null> => {
        if (!adapter.sendLocalFile) return null;
        return adapter.sendLocalFile(chatId, filePath);
      };

      const isKnownCustomCommand = async (name: string): Promise<boolean | null> => {
        try {
          const res = await api.command.list();
          const list = asArray(res, toNamedRecord);
          return list.some(cmd => cmd.name === name);
        } catch {
          return null;
        }
      };

      const replyPermissionRequest = async (
        sessionId: string,
        permissionID: string,
        decision: 'allow_once' | 'allow_always' | 'reject_permission',
      ): Promise<void> => {
        const response: 'once' | 'always' | 'reject' =
          decision === 'allow_once'
            ? 'once'
            : decision === 'allow_always'
              ? 'always'
              : 'reject';
        // Prefer v2 permission.reply when available; fallback to v1 session permission endpoint.
        const apiAny = api as unknown as {
          permission?: { reply?: (args: unknown) => Promise<unknown> };
          postSessionIdPermissionsPermissionId?: (args: unknown) => Promise<unknown>;
        };
        if (apiAny.permission?.reply) {
          await apiAny.permission.reply({
            path: { requestID: permissionID },
            body: { reply: response },
          });
          bridgeLogger.info(
            `[BridgePermission] reply sent(v2) sid=${sessionId} requestID=${permissionID} reply=${response}`,
          );
          return;
        }

        if (!apiAny.postSessionIdPermissionsPermissionId) {
          throw new Error('permission reply endpoint unavailable');
        }
        await apiAny.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID },
          body: { response },
        });
        bridgeLogger.info(
          `[BridgePermission] reply sent(v1) sid=${sessionId} permissionID=${permissionID} response=${response}`,
        );
      };

      const replyQuestionRequest = async (
        sessionId: string,
        requestID: string,
        answers: Array<{ selectedLabel: string }>,
      ): Promise<'v2' | 'fallback'> => {
        const apiAny = api as unknown as {
          question?: { reply?: (args: unknown) => Promise<unknown> };
        };
        if (apiAny.question?.reply) {
          await apiAny.question.reply({
            path: { requestID },
            body: {
              answers: answers.map(ans => [ans.selectedLabel]),
            },
          });
          bridgeLogger.info(
            `[QuestionFlow] reply sent(v2) sid=${sessionId} requestID=${requestID} answers=${answers.length}`,
          );
          return 'v2';
        }
        bridgeLogger.warn(
          `[QuestionFlow] question.reply endpoint unavailable sid=${sessionId} requestID=${requestID}, fallback=resume-prompt`,
        );
        return 'fallback';
      };

      const pendingAuthorization = deps.chatPendingAuthorization.get(cacheKey);
      if (pendingAuthorization && !slash) {
        let decision = parseAuthorizationReply(text || '');
        if (pendingAuthorization.mode === 'session_blocked') {
          if (decision === 'allow_once') decision = 'resume_blocked';
          if (decision === 'allow_always' || decision === 'reject_permission') {
            decision = 'start_new_session';
          }
        }
        const hasPayload = hasText || ((parts || []).length > 0);

        if (decision === 'empty' && !hasPayload) {
          await adapter.sendMessage(chatId, renderAuthorizationReplyHint());
          return;
        }

        if (pendingAuthorization.mode === 'permission_request') {
          if (
            decision === 'allow_once' ||
            decision === 'allow_always' ||
            decision === 'reject_permission'
          ) {
            if (!pendingAuthorization.permissionID) {
              deps.clearPendingAuthorizationForChat(cacheKey);
              await adapter.sendMessage(chatId, `${ERROR_HEADER}\n权限请求缺少 permissionID，已取消。`);
              return;
            }
            await replyPermissionRequest(
              pendingAuthorization.sessionId,
              pendingAuthorization.permissionID,
              decision,
            );
            deps.clearPendingAuthorizationForChat(cacheKey);
            const statusMode =
              decision === 'allow_once'
                ? 'permission-once'
                : decision === 'allow_always'
                  ? 'permission-always'
                  : 'permission-reject';
            await adapter.sendMessage(chatId, renderAuthorizationStatus(statusMode)).catch(() => {});
            return;
          }
          deps.clearPendingAuthorizationForChat(cacheKey);
          bridgeLogger.info(
            `[BridgePermission] non-option input -> handover to model adapter=${adapterKey} chat=${chatId}`,
          );
        } else if (decision === 'resume_blocked') {
          try {
            await submitPrompt(
              pendingAuthorization.sessionId,
              pendingAuthorization.deferredParts || [],
            );
            deps.clearPendingAuthorizationForChat(cacheKey);
            await adapter.sendMessage(chatId, renderAuthorizationStatus('resume')).catch(() => {});
          } catch (resumeErr) {
            if (isLikelyPermissionBlockedError(resumeErr)) {
              await adapter.sendMessage(chatId, renderAuthorizationStatus('still-blocked')).catch(() => {});
              return;
            }
            throw resumeErr;
          }
          return;
        } else {
          deps.clearPendingAuthorizationForChat(cacheKey);
          if (decision === 'start_new_session') {
            const nextSessionId = await createNewSession();
            if (!nextSessionId) throw new Error('Failed to init Session');
            await adapter.sendMessage(chatId, renderAuthorizationStatus('switch-new')).catch(() => {});
            return;
          }
          bridgeLogger.info(
            `[BridgePermission] blocked-session non-option -> handover to model adapter=${adapterKey} chat=${chatId}`,
          );
        }
      }

      if (slash) {
        const handled = await handleSlashCommand({
          api,
          adapterKey,
          chatId,
          senderId,
          cacheKey,
          slash,
          normalizedCommand: normalizedCommand || '',
          targetSessionId,
          targetAgent,
          shouldCreateNew,
          sessionCache: deps.sessionCache,
          sessionToAdapterKey: deps.sessionToAdapterKey,
          sessionToCtx: deps.sessionToCtx,
          chatAgent: deps.chatAgent,
          chatModel: deps.chatModel,
          chatSessionList: deps.chatSessionList,
          chatAgentList: deps.chatAgentList,
          chatAwaitingSaveFile: deps.chatAwaitingSaveFile,
          chatMaxFileSizeMb: deps.chatMaxFileSizeMb,
          chatMaxFileRetry: deps.chatMaxFileRetry,
          chatPendingQuestion: deps.chatPendingQuestion,
          chatPendingAuthorization: deps.chatPendingAuthorization,
          pendingAuthorizationTimers: deps.pendingAuthorizationTimers,
          clearPendingQuestionForChat: deps.clearPendingQuestionForChat,
          clearPendingAuthorizationForChat: deps.clearPendingAuthorizationForChat,
          clearAllPendingAuthorizations: deps.clearAllPendingAuthorizations,
          markQuestionCallHandled: deps.markQuestionCallHandled,
          clearAllPendingQuestions: deps.clearAllPendingQuestions,
          ensureSession,
          createNewSession,
          sendCommandMessage,
          sendErrorMessage,
          sendUnsupported,
          isKnownCustomCommand,
          sendLocalFile,
        });
        if (handled) return;
      }

      const pendingQuestion = deps.chatPendingQuestion.get(cacheKey);
      if (pendingQuestion && !slash) {
        if (!hasText) {
          await adapter.sendMessage(chatId, renderReplyHint(pendingQuestion));
          return;
        }

        const resolved = parseUserReply(text, pendingQuestion);
        if (!resolved.ok) {
          deps.markQuestionCallHandled(cacheKey, pendingQuestion.messageId, pendingQuestion.callID);
          deps.clearPendingQuestionForChat(cacheKey);
          bridgeLogger.info(
            `[QuestionFlow] invalid-option-exit adapter=${adapterKey} chat=${chatId} sid=${pendingQuestion.sessionId} call=${pendingQuestion.callID} reason=${resolved.reason}`,
          );
        } else {
          const sessionId = await ensureSession();
          deps.sessionToAdapterKey.set(sessionId, adapterKey);
          deps.sessionToCtx.set(sessionId, { chatId, senderId });
          let questionReplied = false;
          try {
            const mode = await replyQuestionRequest(
              sessionId,
              pendingQuestion.callID,
              resolved.answers,
            );
            questionReplied = mode === 'v2';
          } catch (replyErr) {
            bridgeLogger.warn(
              `[QuestionFlow] reply failed sid=${sessionId} requestID=${pendingQuestion.callID}`,
              replyErr,
            );
          }

          if (!questionReplied) {
            const resumeParts: Array<TextPartInput | FilePartInput> = [
              {
                type: 'text',
                text: buildResumePrompt(pendingQuestion, resolved.answers, 'user'),
                metadata: buildBridgePartMetadata({
                  adapterKey,
                  chatId,
                  senderId,
                  sessionId,
                  source: 'bridge.question.resume',
                }),
              },
            ];
            try {
              await submitPrompt(sessionId, resumeParts);
            } catch (submitErr) {
              if (!isLikelyPermissionBlockedError(submitErr)) throw submitErr;
              await armPendingAuthorization(
                sessionId,
                'bridge.question.resume',
                resumeParts,
                extractErrorMessage(submitErr) || '当前会话需要网页权限确认',
              );
            }
          }

          deps.markQuestionCallHandled(cacheKey, pendingQuestion.messageId, pendingQuestion.callID);
          deps.clearPendingQuestionForChat(cacheKey);
          await adapter.sendMessage(chatId, renderAnswerSummary(pendingQuestion, resolved.answers, 'user'));
          return;
        }
      }

      const fileParts = (parts || []).filter(isFilePartInput);
      if (fileParts.length > 0 && messageId) {
        shouldClearProgressMsg = true;
      }

      if (fileParts.length > 0) {
        const isSaveFileMode = deps.chatAwaitingSaveFile.get(cacheKey) === true;
        bridgeLogger.info(
          `[Incoming] file-parts adapter=${adapterKey} chat=${chatId} count=${fileParts.length}`,
        );
        fileParts.forEach((p, idx) => {
          bridgeLogger.info(
            `[Bridge] 📎 [${adapterKey}] file[${idx}] name=${p.filename || ''} mime=${p.mime || ''} url=${(p.url || '').slice(0, 64)}${(p.url || '').length > 64 ? '...' : ''}`,
          );
        });

        const saved: string[] = [];
        const duplicated: string[] = [];
        let failed = 0;

        bridgeLogger.info(
          `[Incoming] files-received adapter=${adapterKey} chat=${chatId} count=${fileParts.length}`,
        );

        for (const p of fileParts) {
          const res = await saveFilePartToLocal(cacheKey, p, {
            enqueue: !isSaveFileMode,
          });
          if (res.ok && res.record) {
            if (res.duplicated) duplicated.push(res.record.path);
            else saved.push(res.record.path);
          } else {
            failed++;
          }
        }

        if (isSaveFileMode) {
          deps.chatAwaitingSaveFile.delete(cacheKey);
          const lines: string[] = ['## Status'];
          if (saved.length > 0) {
            lines.push(`✅ 文件已保存：\n${saved.map(p => `- ${p}`).join('\n')}`);
          }
          if (duplicated.length > 0) {
            lines.push(`🟡 文件已存在：\n${duplicated.map(p => `- ${p}`).join('\n')}`);
          }
          if (failed > 0) {
            lines.push('❌ 部分文件保存失败，请重试 /savefile');
          }
          if (saved.length === 0 && duplicated.length === 0 && failed === 0) {
            lines.push('❌ 未检测到可保存文件，请重试 /savefile');
          }
          await adapter.sendMessage(chatId, lines.join('\n'));
          return;
        }

        if (!hasText) {
          bridgeLogger.info(
            `[Incoming] file-only adapter=${adapterKey} chat=${chatId} saved=${saved.length} duplicated=${duplicated.length} failed=${failed}`,
          );
          const lines: string[] = [];
          if (saved.length > 0 && failed === 0 && duplicated.length === 0) {
            lines.push(
              `## Status\n✅ 图片/文件保存成功：\n${saved
                .map(p => `- ${p}`)
                .join('\n')}\n⏳ 等候指令。`,
            );
          } else if (saved.length === 0 && duplicated.length === 0) {
            lines.push('## Status\n❌ 文件上传失败，请重试。');
          } else {
            lines.push('## Status');
            if (saved.length > 0) {
              lines.push(`✅ 已保存：\n${saved.map(p => `- ${p}`).join('\n')}`);
            }
            if (duplicated.length > 0) {
              lines.push(`🟡 已存在，未重复入队：\n${duplicated.map(p => `- ${p}`).join('\n')}`);
            }
            if (failed > 0) lines.push('❌ 部分文件上传失败，请重试。');
          }

          const content = lines.join('\n');
          const progressMap: Map<string, string> | undefined =
            globalState.__bridge_progress_msg_ids;
          const progressKey = messageId;
          const progressMsgId = progressMap?.get(progressKey);
          if (progressMsgId && adapter.editMessage) {
            const ok = await adapter.editMessage(chatId, progressMsgId, content);
            if (ok) {
              progressMap?.delete(progressKey);
              return;
            }
          }

          await adapter.sendMessage(chatId, content);
          return;
        }
      }

      const sessionId = await ensureSession();
      deps.sessionToAdapterKey.set(sessionId, adapterKey);
      deps.sessionToCtx.set(sessionId, { chatId, senderId });

      const partList: Array<TextPartInput | FilePartInput> = [];
      if (text && text.trim()) {
        partList.push({
          type: 'text',
          text,
          metadata: buildBridgePartMetadata({
            adapterKey,
            chatId,
            senderId,
            sessionId,
            source: 'bridge.incoming',
          }),
        });
      }
      const pendingFiles = await drainPendingFileParts(cacheKey);
      if (pendingFiles.length > 0) {
        bridgeLogger.info(
          `[Incoming] attach-pending-files adapter=${adapterKey} chat=${chatId} count=${pendingFiles.length}`,
        );
        partList.push(...pendingFiles);
      }
      if (partList.length === 0) return;

      bridgeLogger.info(
        `[Incoming] prompt adapter=${adapterKey} chat=${chatId} parts=${partList.length} text=${hasText} files=${pendingFiles.length} agent=${deps.chatAgent.get(cacheKey) || '-'} model=${deps.chatModel.get(cacheKey)?.name || deps.chatModel.get(cacheKey)?.modelID || '-'}`,
      );
      try {
        await submitPrompt(sessionId, partList);
      } catch (submitErr) {
        if (!isLikelyPermissionBlockedError(submitErr)) throw submitErr;
        await armPendingAuthorization(
          sessionId,
          'bridge.incoming',
          partList,
          extractErrorMessage(submitErr) || '当前会话需要网页权限确认',
        );
        return;
      }
      bridgeLogger.info(`[Incoming] prompt-sent adapter=${adapterKey} session=${sessionId}`);
    } catch (err: unknown) {
      bridgeLogger.error(`[Incoming] adapter=${adapterKey} chat=${chatId} failed`, err);
      await adapter.sendMessage(chatId, `${ERROR_HEADER}\n${deps.formatUserError(err)}`);
    } finally {
      if (shouldClearProgressMsg && messageId) {
        globalState.__bridge_progress_msg_ids?.delete(messageId);
      }
      if (messageId && reactionId && adapter.removeReaction) {
        await adapter.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
