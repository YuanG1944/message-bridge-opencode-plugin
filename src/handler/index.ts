// src/handler/index.ts
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { BridgeAdapter } from '../types';
import { LOADING_EMOJI } from '../constants';
import { AdapterMux } from './mux';

import {
  simpleHash,
  buildDisplayContent,
  getOrInitBuffer,
  markStatus,
  applyPartToBuffer,
  shouldFlushNow,
} from '../bridge/buffer';

import { parseSlashCommand, sleep } from '../utils';

type SessionContext = { chatId: string; senderId: string };

const sessionToCtx = new Map<string, SessionContext>(); // sessionId -> chat context
const sessionActiveMsg = new Map<string, string>(); // sessionId -> active assistant messageID
const msgRole = new Map<string, string>(); // messageId -> role
const msgBuffers = new Map<string, any>(); // messageId -> buffer (MessageBuffer)
const sessionCache = new Map<string, string>(); // adapterKey:chatId -> sessionId
const sessionToAdapterKey = new Map<string, string>(); // sessionId -> adapterKey
const chatAgent = new Map<string, string>(); // adapterKey:chatId -> agent
const chatSessionList = new Map<string, Array<{ id: string; title: string }>>();

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
}

/**
 * Incoming handler：每个平台传 adapterKey，自动绑定 session->adapterKey
 */
export const createIncomingHandler = (api: OpencodeClient, mux: AdapterMux, adapterKey: string) => {
  const adapter = mux.get(adapterKey);
  if (!adapter) throw new Error(`[Handler] Adapter not found: ${adapterKey}`);

  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 [${adapterKey}] Incoming: "${text}" chat=${chatId}`);

    const slash = parseSlashCommand(text);
    const cacheKey = `${adapterKey}:${chatId}`;
    const normalizedCommand =
      slash?.command === 'resume' || slash?.command === 'continue'
        ? 'sessions'
        : slash?.command === 'summarize'
        ? 'compact'
        : slash?.command === 'clear'
        ? 'new'
        : slash?.command;
    const targetSessionId =
      normalizedCommand === 'sessions' && slash?.arguments
        ? slash.arguments.trim().split(/\s+/)[0]
        : null;
    const targetAgent =
      normalizedCommand === 'agent' && slash?.arguments
        ? slash.arguments.trim().split(/\s+/)[0]
        : null;
    const shouldCreateNew = normalizedCommand === 'new';
    const unsupportedCommands = new Set([
      'connect',
      'details',
      'editor',
      'export',
      'exit',
      'quit',
      'q',
      'theme',
      'themes',
      'thinking',
    ]);

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

      const sendUnsupported = async () => {
        await adapter.sendMessage(chatId, `❌ 命令 /${slash?.command} 暂不支持在聊天中使用。`);
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
        if (normalizedCommand === 'help') {
          const res = await api.command.list();
          const data = (res as any)?.data ?? res;
          const list = Array.isArray(data) ? data : [];

          const lines: string[] = [];
          lines.push('## Command');
          lines.push('### Help');
          lines.push('/help - 查看命令与用法');
          lines.push('/models - 查看可用模型');
          lines.push('/new - 新建会话并切换');
          lines.push('/sessions - 列出会话（用 /sessions <id> 或 /sessions <序号> 切换）');
          lines.push('/share - 分享当前会话');
          lines.push('/unshare - 取消分享');
          lines.push('/compact - 压缩/总结当前会话');
          lines.push('/init - 初始化项目（生成 AGENTS.md）');
          lines.push('/agent <name> - 切换 Agent');

          if (list.length > 0) {
            lines.push('### Custom Commands');
            list.forEach((cmd: any) => {
              const desc = cmd?.description ? `- ${cmd.description}` : '';
              lines.push(`/${cmd?.name} ${desc}`);
            });
          }
          await adapter.sendMessage(chatId, lines.join('\n'));
          return;
        }

        if (normalizedCommand === 'models') {
          const res = await api.config.providers();
          const data = (res as any)?.data ?? res;
          const providers = data?.providers ?? [];
          const defaults = data?.default ?? {};

          if (!Array.isArray(providers) || providers.length === 0) {
            await adapter.sendMessage(chatId, '暂无可用模型信息。');
            return;
          }

          const lines: string[] = [];
          lines.push('## Command');
          lines.push('### Models');

          const defaultLines: string[] = [];
          Object.keys(defaults || {}).forEach(key => {
            defaultLines.push(`${key} -> ${defaults[key]}`);
          });
          if (defaultLines.length > 0) {
            lines.push('Default:');
            defaultLines.forEach(l => lines.push(l));
          }

          providers.forEach((p: any) => {
            const id = p?.id || p?.name || 'unknown';
            const models = p?.models ? Object.keys(p.models) : [];
            lines.push(`${p?.name || id} (${id})`);
            lines.push(`Models: ${models.join(', ') || '-'}`);
          });

          await adapter.sendMessage(chatId, lines.join('\n'));
          return;
        }

        if (normalizedCommand === 'agent' && targetAgent) {
          chatAgent.set(cacheKey, targetAgent);
          await adapter.sendMessage(chatId, `✅ 已切换 Agent: ${targetAgent}`);
          return;
        }

        if (normalizedCommand === 'sessions' && !targetSessionId) {
          const res = await api.session.list({});
          const data = (res as any)?.data ?? res;
          const sessions = Array.isArray(data) ? data : [];
          if (sessions.length === 0) {
            await adapter.sendMessage(chatId, '暂无会话，请使用 /new 创建。');
            return;
          }
          const list = sessions.slice(0, 20).map((s: any) => ({
            id: s?.id,
            title: s?.title || 'Untitled',
          }));
          chatSessionList.set(cacheKey, list);
          const lines = ['## Command', '### Sessions', '请输入 /sessions <序号> 切换：'];
          list.forEach((s, idx) => {
            lines.push(`${idx + 1}. ${s.title}`);
          });
          await adapter.sendMessage(chatId, lines.join('\n'));
          return;
        }

        if (unsupportedCommands.has(normalizedCommand || '')) {
          await sendUnsupported();
          return;
        }

        if (shouldCreateNew) {
          const sessionId = await createNewSession();
          console.log(`[Bridge] [${adapterKey}] [Session: ${sessionId}] 🆕 New Session Bound.`);
          if (sessionId) {
            await adapter.sendMessage(chatId, `✅ 已切换到新会话: ${sessionId}`);
          } else {
            await adapter.sendMessage(chatId, '❌ 新会话创建失败，请稍后重试。');
          }
          return;
        }

        const sessionId = await ensureSession();

        // ✅ 绑定：这个 session 的输出回到哪个平台
        sessionToAdapterKey.set(sessionId, adapterKey);
        sessionToCtx.set(sessionId, { chatId, senderId });

        if (normalizedCommand === 'sessions' && targetSessionId) {
          let targetId = targetSessionId;
          if (/^\d+$/.test(targetSessionId)) {
            const list = chatSessionList.get(cacheKey) || [];
            const idx = Number(targetSessionId) - 1;
            if (idx >= 0 && idx < list.length) {
              targetId = list[idx].id;
            } else {
              await adapter.sendMessage(chatId, `❌ 无效序号: ${targetSessionId}`);
              return;
            }
          }
          sessionCache.set(cacheKey, targetId);
          sessionToAdapterKey.set(targetId, adapterKey);
          sessionToCtx.set(targetId, { chatId, senderId });
          chatAgent.delete(cacheKey);
          await adapter.sendMessage(chatId, `✅ 已切换到会话: ${targetId}`);
          return;
        }

        if (normalizedCommand === 'share') {
          const res = await api.session.share({ path: { id: sessionId } });
          const data = (res as any)?.data ?? res;
          const url = data?.share?.url;
          await adapter.sendMessage(chatId, url ? `✅ 分享链接: ${url}` : '✅ 已分享会话。');
          return;
        }

        if (normalizedCommand === 'unshare') {
          await api.session.unshare({ path: { id: sessionId } });
          await adapter.sendMessage(chatId, '✅ 已取消分享。');
          return;
        }

        if (normalizedCommand === 'compact') {
          await api.session.summarize({ path: { id: sessionId } });
          await adapter.sendMessage(chatId, '✅ 已触发会话压缩。');
          return;
        }

        if (normalizedCommand === 'init') {
          await api.session.init({ path: { id: sessionId } });
          await adapter.sendMessage(chatId, '✅ 已触发初始化（AGENTS.md）。');
          return;
        }

        const isCustom = await isKnownCustomCommand(slash.command);
        if (isCustom === false) {
          await adapter.sendMessage(chatId, `❌ 无效指令: /${slash.command}`);
          return;
        }

        await api.session.command({
          path: { id: sessionId },
          body: { command: slash.command, arguments: slash.arguments },
        });
        console.log(`[Bridge] [${adapterKey}] [Session: ${sessionId}] 🚀 Command /${slash.command} Sent.`);
        return;
      }

      const sessionId = await ensureSession();
      // ✅ 绑定：这个 session 的输出回到哪个平台
      sessionToAdapterKey.set(sessionId, adapterKey);
      sessionToCtx.set(sessionId, { chatId, senderId });

      const agent = chatAgent.get(cacheKey);
      await api.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }], ...(agent ? { agent } : {}) },
      });

      console.log(`[Bridge] [${adapterKey}] [Session: ${sessionId}] 🚀 Prompt Sent.`);
    } catch (err: any) {
      console.error(`[Bridge] ❌ [${adapterKey}] Error:`, err);
      await adapter.sendMessage(chatId, `❌ Error: ${err?.message || String(err)}`);
    } finally {
      if (messageId && reactionId && adapter.removeReaction) {
        await adapter.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
