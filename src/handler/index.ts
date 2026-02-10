// src/handler/index.ts
import type { FilePartInput, OpencodeClient, TextPartInput } from '@opencode-ai/sdk';
import type { BridgeAdapter } from '../types';
import { LOADING_EMOJI } from '../constants';
import { AdapterMux } from './mux';
import { handleSlashCommand } from './command';

import {
  simpleHash,
  buildDisplayContent,
  getOrInitBuffer,
  markStatus,
  applyPartToBuffer,
  shouldFlushNow,
} from '../bridge/buffer';
import { drainPendingFileParts, saveFilePartToLocal } from '../bridge/fileStore';

import { ERROR_HEADER, parseSlashCommand, sleep, globalState } from '../utils';

type SessionContext = { chatId: string; senderId: string };

const sessionToCtx = new Map<string, SessionContext>(); // sessionId -> chat context
const sessionActiveMsg = new Map<string, string>(); // sessionId -> active assistant messageID
const msgRole = new Map<string, string>(); // messageId -> role
const msgBuffers = new Map<string, any>(); // messageId -> buffer (MessageBuffer)
const sessionCache = new Map<string, string>(); // adapterKey:chatId -> sessionId
const sessionToAdapterKey = new Map<string, string>(); // sessionId -> adapterKey
const chatAgent = new Map<string, string>(); // adapterKey:chatId -> agent
const chatSessionList = new Map<string, Array<{ id: string; title: string }>>();
const chatAgentList = new Map<string, Array<{ id: string; name: string }>>();
const chatMaxFileSizeMb: Map<string, number> =
  globalState.__bridge_max_file_size || new Map<string, number>();
const chatMaxFileRetry: Map<string, number> =
  globalState.__bridge_max_file_retry || new Map<string, number>();
globalState.__bridge_max_file_size = chatMaxFileSizeMb;
globalState.__bridge_max_file_retry = chatMaxFileRetry;

let isListenerStarted = false;
let shouldStopListener = false;

function isAbortedError(err: any): boolean {
  return err?.name === 'MessageAbortedError';
}
function isOutputLengthError(err: any): boolean {
  return err?.name === 'MessageOutputLengthError';
}
function isApiError(err: any): boolean {
  return err?.name === 'APIError';
}

function formatUserError(err: any): string {
  const msg = String(err?.message || err?.data?.message || 'unknown error');
  if (msg.toLowerCase().includes('socket connection was closed unexpectedly')) {
    return '网络异常，资源下载失败，请稍后重试。';
  }
  return msg.split('\n')[0].slice(0, 200);
}

async function safeEditWithRetry(
  adapter: BridgeAdapter,
  chatId: string,
  platformMsgId: string,
  content: string
): Promise<boolean> {
  const ok = await adapter.editMessage(chatId, platformMsgId, content);
  if (ok) return true;
  await sleep(500);
  return adapter.editMessage(chatId, platformMsgId, content);
}

async function flushMessage(
  adapter: BridgeAdapter,
  chatId: string,
  messageId: string,
  force = false
) {
  const buffer = msgBuffers.get(messageId);
  if (!buffer?.platformMsgId) return;

  const content = buildDisplayContent(buffer);
  if (!content.trim()) return;

  const hash = simpleHash(content);
  if (!force && hash === buffer.lastDisplayHash) return;

  buffer.lastDisplayHash = hash;
  await safeEditWithRetry(adapter, chatId, buffer.platformMsgId, content).catch(() => {});
}

async function flushAll(mux: AdapterMux) {
  for (const [sid, mid] of sessionActiveMsg.entries()) {
    const ctx = sessionToCtx.get(sid);
    const adapterKey = sessionToAdapterKey.get(sid);
    if (!ctx || !mid || !adapterKey) continue;

    const adapter = mux.get(adapterKey);
    if (!adapter) continue;

    await flushMessage(adapter, ctx.chatId, mid, true);
  }
}

export async function startGlobalEventListener(api: OpencodeClient, mux: AdapterMux) {
  if (isListenerStarted) return;
  isListenerStarted = true;
  shouldStopListener = false;

  console.log('[Listener] 🎧 Starting Global Event Subscription (MUX)...');

  let retryCount = 0;

  const connect = async () => {
    try {
      const events = await api.event.subscribe();
      console.log('[Listener] ✅ Connected to OpenCode Event Stream');
      retryCount = 0;

      for await (const event of events.stream) {
        if (shouldStopListener) break;

        // 1) message.updated
        if (event.type === 'message.updated') {
          const info = event.properties?.info;
          if (info?.id && info?.role) msgRole.set(info.id, info.role);

          if (info?.role === 'assistant' && info?.id && info?.sessionID) {
            const sid = info.sessionID as string;
            const mid = info.id as string;

            const ctx = sessionToCtx.get(sid);
            const adapterKey = sessionToAdapterKey.get(sid);
            const adapter = adapterKey ? mux.get(adapterKey) : undefined;
            if (!ctx || !adapter) continue;

            sessionActiveMsg.set(sid, mid);

            if (info.error) {
              if (isAbortedError(info.error)) {
                markStatus(
                  msgBuffers,
                  mid,
                  'aborted',
                  (info?.error?.data?.message as string) || 'aborted'
                );
              } else if (isOutputLengthError(info.error)) {
                markStatus(msgBuffers, mid, 'error', 'output too long');
              } else if (isApiError(info.error)) {
                markStatus(
                  msgBuffers,
                  mid,
                  'error',
                  (info.error?.data?.message as string) || 'api error'
                );
              } else {
                markStatus(
                  msgBuffers,
                  mid,
                  'error',
                  (info.error?.data?.message as string) || info.error?.name || 'error'
                );
              }
              await flushMessage(adapter, ctx.chatId, mid, true);
            } else if (info.finish || info.time?.completed) {
              markStatus(msgBuffers, mid, 'done', info.finish || 'completed');
              await flushMessage(adapter, ctx.chatId, mid, true);
            }
          }
          continue;
        }

        // 2) message.part.updated
        if (event.type === 'message.part.updated') {
          const part = event.properties?.part;
          const delta: string | undefined = event.properties?.delta;

          const sessionId = part?.sessionID;
          const messageId = part?.messageID;
          if (!sessionId || !messageId || !part) continue;

          if (msgRole.get(messageId) === 'user') continue;

          const ctx = sessionToCtx.get(sessionId);
          const adapterKey = sessionToAdapterKey.get(sessionId);
          const adapter = adapterKey ? mux.get(adapterKey) : undefined;
          if (!ctx || !adapter) continue;

          // session 内切换到新 assistant message：先 flush 旧的
          const prev = sessionActiveMsg.get(sessionId);
          if (prev && prev !== messageId) {
            markStatus(msgBuffers, prev, 'done');
            await flushMessage(adapter, ctx.chatId, prev, true);
          }
          sessionActiveMsg.set(sessionId, messageId);

          const buffer = getOrInitBuffer(msgBuffers, messageId);

          applyPartToBuffer(buffer, part, delta);

          // step-finish：只作为状态 done 的信号之一（不覆盖 aborted/error）
          if (part.type === 'step-finish') {
            if (buffer.status === 'streaming') {
              markStatus(msgBuffers, messageId, 'done', part.reason || 'step-finish');
            }
          }

          if (!shouldFlushNow(buffer)) continue;

          const hasAny =
            buffer.reasoning.length > 0 || buffer.text.length > 0 || buffer.tools.size > 0;
          if (!hasAny) continue;

          buffer.lastUpdateTime = Date.now();

          const display = buildDisplayContent(buffer);
          const hash = simpleHash(display);
          if (buffer.platformMsgId && hash === buffer.lastDisplayHash) continue;

          if (!buffer.platformMsgId) {
            const sent = await adapter.sendMessage(ctx.chatId, display);
            if (sent) {
              buffer.platformMsgId = sent;
              buffer.lastDisplayHash = hash;
            }
          } else {
            const ok = await safeEditWithRetry(adapter, ctx.chatId, buffer.platformMsgId, display);
            if (ok) buffer.lastDisplayHash = hash;
          }

          continue;
        }

        // 3) session.error：abort 最常在这里出现
        if (event.type === 'session.error') {
          const sid = event.properties?.sessionID;
          const err = event.properties?.error;
          if (!sid) continue;

          const ctx = sessionToCtx.get(sid);
          const adapterKey = sessionToAdapterKey.get(sid);
          const adapter = adapterKey ? mux.get(adapterKey) : undefined;
          const mid = sessionActiveMsg.get(sid);

          if (ctx && adapter && mid) {
            if (isAbortedError(err)) {
              markStatus(msgBuffers, mid, 'aborted', (err?.data?.message as string) || 'aborted');
            } else {
              markStatus(
                msgBuffers,
                mid,
                'error',
                (err?.data?.message as string) || err?.name || 'session.error'
              );
            }
            await flushMessage(adapter, ctx.chatId, mid, true);
          }
          continue;
        }

        // 4) session.idle：作为“本轮结束”的可靠信号
        if (event.type === 'session.idle') {
          const sid = event.properties?.sessionID;
          if (!sid) continue;

          const ctx = sessionToCtx.get(sid);
          const adapterKey = sessionToAdapterKey.get(sid);
          const adapter = adapterKey ? mux.get(adapterKey) : undefined;
          const mid = sessionActiveMsg.get(sid);

          if (ctx && adapter && mid) {
            const buf = msgBuffers.get(mid);
            if (buf && (buf.status === 'aborted' || buf.status === 'error')) {
              await flushMessage(adapter, ctx.chatId, mid, true);
            } else {
              markStatus(msgBuffers, mid, 'done', 'idle');
              await flushMessage(adapter, ctx.chatId, mid, true);
            }
          }
          continue;
        }

        // 5) command.executed：标记本条消息为 command 输出
        if (event.type === 'command.executed') {
          const mid = event.properties?.messageID;
          if (mid) {
            const buf = getOrInitBuffer(msgBuffers, mid);
            buf.isCommand = true;
          }
          continue;
        }
      }

      await flushAll(mux);
    } catch (e) {
      if (shouldStopListener) return;

      console.error('[Listener] ❌ Stream Disconnected:', e);
      await flushAll(mux);

      const delay = Math.min(5000 * (retryCount + 1), 60000);
      retryCount++;
      setTimeout(connect, delay);
    }
  };

  connect();
}

export function stopGlobalEventListener() {
  shouldStopListener = true;
  isListenerStarted = false;

  sessionToCtx.clear();
  sessionActiveMsg.clear();
  msgRole.clear();
  msgBuffers.clear();
  sessionCache.clear();
  sessionToAdapterKey.clear();
  chatAgent.clear();
  chatSessionList.clear();
  chatAgentList.clear();
  chatMaxFileSizeMb.clear();
  chatMaxFileRetry.clear();
}

/**
 * Incoming handler：每个平台传 adapterKey，自动绑定 session->adapterKey
 */
export const createIncomingHandler = (api: OpencodeClient, mux: AdapterMux, adapterKey: string) => {
  const adapter = mux.get(adapterKey);
  if (!adapter) throw new Error(`[Handler] Adapter not found: ${adapterKey}`);

  return async (
    chatId: string,
    text: string,
    messageId: string,
    senderId: string,
    parts?: Array<TextPartInput | FilePartInput>
  ) => {
    console.log(
      `[Bridge] 📥 [${adapterKey}] Incoming chat=${chatId} sender=${senderId} msg=${messageId} text="${text || ''}" parts=${parts?.length || 0}`,
    );

    const slash = parseSlashCommand(text);
    const cacheKey = `${adapterKey}:${chatId}`;
    const rawCommand = slash?.command?.toLowerCase();
    const normalizedCommand =
      rawCommand === 'resume' || rawCommand === 'continue'
        ? 'sessions'
        : rawCommand === 'summarize'
        ? 'compact'
        : rawCommand === 'clear'
        ? 'new'
        : rawCommand;
    const targetSessionId =
      normalizedCommand === 'sessions' && slash?.arguments
        ? slash.arguments.trim().split(/\s+/)[0]
        : null;
    const targetAgentArg = slash?.arguments ? slash.arguments.trim() : '';
    const targetAgent =
      normalizedCommand === 'agent' && targetAgentArg
        ? targetAgentArg
        : null;
    const shouldCreateNew = normalizedCommand === 'new';

    if (!slash && text.trim().toLowerCase() === 'ping') {
      await adapter.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;

    try {
      if (messageId && adapter.addReaction) {
        reactionId = await adapter.addReaction(messageId, LOADING_EMOJI);
      }

      const createNewSession = async () => {
        const uniqueTitle = `[${adapterKey}] Chat ${chatId.slice(
          -4
        )} [${new Date().toLocaleTimeString()}]`;
        const res = await api.session.create({ body: { title: uniqueTitle } });
        const sessionId = (res as any)?.data?.id;
        if (sessionId) {
          sessionCache.set(cacheKey, sessionId);
          sessionToAdapterKey.set(sessionId, adapterKey);
          sessionToCtx.set(sessionId, { chatId, senderId });
          chatAgent.delete(cacheKey);
        }
        return sessionId;
      };

      const ensureSession = async () => {
        let sessionId = sessionCache.get(cacheKey);
        
        if (!sessionId) {
          sessionId = await createNewSession();
        }
        if (!sessionId) throw new Error('Failed to init Session');
        return sessionId;
      };

      const sendCommandMessage = async (content: string) => {
        await adapter.sendMessage(chatId, `## Command\n${content}`);
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

      const isKnownCustomCommand = async (name: string): Promise<boolean | null> => {
        try {
          const res = await api.command.list();
          const data = (res as any)?.data ?? res;
          const list = Array.isArray(data) ? data : [];
          return list.some((cmd: any) => cmd?.name === name);
        } catch {
          return null;
        }
      };

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
          sessionCache,
          sessionToAdapterKey,
          sessionToCtx,
          chatAgent,
          chatSessionList,
          chatAgentList,
          chatMaxFileSizeMb,
          chatMaxFileRetry,
          ensureSession,
          createNewSession,
          sendCommandMessage,
          sendErrorMessage,
          sendUnsupported,
          isKnownCustomCommand,
        });
        if (handled) return;
      }

      const fileParts = (parts || []).filter(p => (p as any)?.type === 'file') as FilePartInput[];
      const hasText = Boolean(text && text.trim());

      if (fileParts.length > 0) {
        console.log(
          `[Bridge] 📎 [${adapterKey}] file parts detail count=${fileParts.length} chat=${chatId}`,
        );
        fileParts.forEach((p, idx) => {
          console.log(
            `[Bridge] 📎 [${adapterKey}] file[${idx}] name=${p.filename || ''} mime=${p.mime || ''} url=${(p.url || '').slice(0, 64)}${(p.url || '').length > 64 ? '...' : ''}`,
          );
        });

        const saved: string[] = [];
        const duplicated: string[] = [];
        let failed = 0;

        console.log(
          `[Bridge] 📁 [${adapterKey}] received ${fileParts.length} file(s) chat=${chatId}`,
        );

        for (const p of fileParts) {
          const res = await saveFilePartToLocal(cacheKey, p);
          if (res.ok && res.record) {
            if (res.duplicated) duplicated.push(res.record.path);
            else saved.push(res.record.path);
          } else {
            failed++;
          }
        }

        if (!hasText) {
          console.log(
            `[Bridge] 📁 [${adapterKey}] file-only message chat=${chatId} saved=${saved.length} duplicated=${duplicated.length} failed=${failed}`,
          );
          const lines: string[] = [];
          if (saved.length > 0 && failed === 0 && duplicated.length === 0) {
            lines.push(
              `## Status\n✅ 图片/文件保存成功：\n${saved
                .map(p => `- ${p}`)
                .join('\n')}\n⏳ 等候指令。`
            );
          } else if (saved.length === 0 && duplicated.length === 0) {
            lines.push('## Status\n❌ 文件上传失败，请重试。');
          } else {
            lines.push('## Status');
            if (saved.length > 0) {
              lines.push(`✅ 已保存：\n${saved.map(p => `- ${p}`).join('\n')}`);
            }
            if (duplicated.length > 0) {
              lines.push(
                `🟡 已存在，未重复入队：\n${duplicated.map(p => `- ${p}`).join('\n')}`
              );
            }
            if (failed > 0) lines.push('❌ 部分文件上传失败，请重试。');
          }

          const content = lines.join('\n');
          const progressMap: Map<string, string> | undefined = globalState.__bridge_progress_msg_ids;
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
      
      // 绑定：这个 session 的输出回到哪个平台
      sessionToAdapterKey.set(sessionId, adapterKey);
      sessionToCtx.set(sessionId, { chatId, senderId });

      const agent = chatAgent.get(cacheKey);
      const partList: Array<TextPartInput | FilePartInput> = [];
      if (text && text.trim()) {
        partList.push({ type: 'text', text });
      }
      const pendingFiles = await drainPendingFileParts(cacheKey);
      if (pendingFiles.length > 0) {
        console.log(
          `[Bridge] 📤 [${adapterKey}] attach pending files count=${pendingFiles.length} chat=${chatId}`,
        );
        partList.push(...pendingFiles);
      }
      if (partList.length === 0) return;

      console.log(
        `[Bridge] 🚀 [${adapterKey}] prompt parts=${partList.length} text=${hasText} files=${pendingFiles.length} chat=${chatId}`,
      );
      await api.session.prompt({
        path: { id: sessionId },
        body: { parts: partList, ...(agent ? { agent } : {}) },
      });

      console.log(`[Bridge] [${adapterKey}] [Session: ${sessionId}] 🚀 Prompt Sent.`);
    } catch (err: any) {
      console.error(`[Bridge] ❌ [${adapterKey}] Error:`, err);
      await adapter.sendMessage(chatId, `${ERROR_HEADER}\n${formatUserError(err)}`);
    } finally {
      if (messageId && reactionId && adapter.removeReaction) {
        await adapter.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
