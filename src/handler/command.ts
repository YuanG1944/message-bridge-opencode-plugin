// src/handler/command.ts
import type { FilePartInput, OpencodeClient, TextPartInput } from '@opencode-ai/sdk';
import {
  DEFAULT_MAX_FILE_MB,
  DEFAULT_MAX_FILE_RETRY,
  globalState,
  isBridgeAgentId,
} from '../utils';
import { bridgeLogger, getBridgeLogFilePath } from '../logger';
import { isRecord, readString, toApiArray, toApiRecord } from './api.response';

type SessionListItem = { id: string; title: string };
type AgentListItem = { id: string; name: string };
type SelectedModel = { providerID: string; modelID: string; name?: string };
type NamedRecord = { id?: string; name?: string; title?: string; description?: string };
type AgentCandidate = AgentListItem & { mode?: string };

type ProviderModelItem = { id: string; name: string; providerID: string };
type ProviderItem = { id: string; models: Record<string, ProviderModelItem> };

function asNamedRecords(value: unknown): NamedRecord[] {
  const list = toApiArray(value);
  if (list.length === 0) return [];
  return list
    .map(item => {
      if (!isRecord(item)) return null;
      return {
        id: typeof item.id === 'string' ? item.id : undefined,
        name: typeof item.name === 'string' ? item.name : undefined,
        title: typeof item.title === 'string' ? item.title : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
      } as NamedRecord;
    })
    .filter((v): v is NamedRecord => v !== null);
}

function toStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function normalizeModels(raw: unknown, fallbackProviderId: string): Record<string, ProviderModelItem> {
  const out: Record<string, ProviderModelItem> = {};

  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      const id = readString(value, 'id', 'modelID', 'modelId') || key;
      const name = readString(value, 'name', 'title') || id;
      const providerID = readString(value, 'providerID', 'providerId') || fallbackProviderId;
      out[key] = { id, name, providerID };
    }
    return out;
  }

  if (Array.isArray(raw)) {
    raw.forEach((item, idx) => {
      if (!isRecord(item)) return;
      const id = readString(item, 'id', 'modelID', 'modelId', 'name');
      if (!id) return;
      const name = readString(item, 'name', 'title') || id;
      const providerID = readString(item, 'providerID', 'providerId') || fallbackProviderId;
      const key = String(idx + 1);
      out[key] = { id, name, providerID };
    });
  }

  return out;
}

function parseProvidersResponse(raw: unknown): {
  providers: ProviderItem[];
  defaults: Record<string, string>;
} {
  const root = toApiRecord(raw) || {};
  const providersRaw = toApiArray(raw, ['providers']);
  const defaultFromDefault = toStringMap(root.default);
  const defaultFromDefaults = toStringMap(root.defaults);
  const defaults =
    Object.keys(defaultFromDefault).length > 0
      ? defaultFromDefault
      : Object.keys(defaultFromDefaults).length > 0
        ? defaultFromDefaults
        : {};

  const providers: ProviderItem[] = providersRaw
    .map((item, idx) => {
      if (!isRecord(item)) return null;
      const providerId =
        readString(item, 'id', 'providerID', 'providerId', 'name') || `provider-${idx + 1}`;
      const models = normalizeModels(
        item.models ?? item.model_list ?? item.items ?? item.list,
        providerId,
      );
      if (Object.keys(models).length === 0) return null;
      return { id: providerId, models };
    })
    .filter((v): v is ProviderItem => v !== null);

  return { providers, defaults: defaults || {} };
}

function extractShareUrl(raw: unknown): string | undefined {
  const root = toApiRecord(raw);
  if (!root) return undefined;
  const direct = readString(root, 'url', 'share_url', 'shareUrl', 'link');
  if (direct) return direct;
  const shareObj = toApiRecord(root.share);
  return readString(shareObj, 'url', 'link');
}

function normalizeAgentCandidate(item: unknown): AgentCandidate | null {
  if (!isRecord(item)) return null;
  const idRaw = typeof item.id === 'string' ? item.id : undefined;
  const nameRaw = typeof item.name === 'string' ? item.name : undefined;
  const id = idRaw || nameRaw;
  if (!id) return null;
  const name = nameRaw || id;
  const mode = typeof item.mode === 'string' ? item.mode : undefined;
  return { id, name, mode };
}

function isMessageBridgeAgentName(nameOrId: string): boolean {
  return isBridgeAgentId(nameOrId);
}

function pickUsableAgents(raw: unknown): AgentListItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeAgentCandidate)
    .filter((a): a is AgentCandidate => a !== null)
    .filter(a => a.mode !== 'subagent')
    .filter(a => !isMessageBridgeAgentName(a.id) && !isMessageBridgeAgentName(a.name))
    .map(a => ({ id: a.id, name: a.name }));
}

function parseSessionDeleteArgs(rawArgs: string): { deleteAll: boolean; refs: string[] } {
  const args = rawArgs.trim();
  const m = args.match(/^(?:del|delete|rm|remove)\s+(.+)$/i);
  if (!m) return { deleteAll: false, refs: [] };
  const rest = m[1].trim();
  if (!rest) return { deleteAll: false, refs: [] };
  if (/^all$/i.test(rest)) return { deleteAll: true, refs: [] };
  const refs = rest
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return { deleteAll: false, refs };
}

function parseSendFilePath(rawArgs: string): string {
  const args = rawArgs.trim();
  if (!args) return '';
  const m = args.match(/^"(.*)"$/) || args.match(/^'(.*)'$/);
  if (m?.[1]) return m[1].trim();
  return args;
}

function toSessionList(raw: unknown): SessionListItem[] {
  return asNamedRecords(raw)
    .map(s => ({ id: s.id || '', title: s.title || 'Untitled' }))
    .filter((s): s is SessionListItem => Boolean(s.id));
}

function resolveSessionRefs(refs: string[], sessions: SessionListItem[]): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (/^\d+$/.test(ref)) {
      const idx = Number(ref) - 1;
      if (idx >= 0 && idx < sessions.length) ids.add(sessions[idx].id);
      continue;
    }
    const exact = sessions.find(s => s.id === ref);
    if (exact) ids.add(exact.id);
  }
  return Array.from(ids);
}

function ensureUniqueSessionTitle(
  desiredTitle: string,
  sessions: SessionListItem[],
  currentSessionId: string,
): string {
  const base = desiredTitle.trim();
  if (!base) return desiredTitle;

  const used = new Set(
    sessions
      .filter(s => s.id !== currentSessionId)
      .map(s => s.title.trim())
      .filter(Boolean),
  );

  if (!used.has(base)) return base;

  let suffix = 2;
  let candidate = base + ' (' + suffix + ')';
  while (used.has(candidate)) {
    suffix++;
    candidate = base + ' (' + suffix + ')';
  }
  return candidate;
}

export type CommandContext = {
  api: OpencodeClient;
  adapterKey: string;
  chatId: string;
  senderId: string;
  cacheKey: string;
  slash: { command: string; arguments: string };
  normalizedCommand: string;
  targetSessionId: string | null;
  targetAgent: string | null;
  shouldCreateNew: boolean;
  sessionCache: Map<string, string>;
  sessionToAdapterKey: Map<string, string>;
  sessionToCtx: Map<string, { chatId: string; senderId: string }>;
  chatAgent: Map<string, string>;
  chatModel: Map<string, SelectedModel>;
  chatSessionList: Map<string, Array<SessionListItem>>;
  chatAgentList: Map<string, Array<AgentListItem>>;
  chatAwaitingSaveFile: Map<string, boolean>;
  chatMaxFileSizeMb: Map<string, number>;
  chatMaxFileRetry: Map<string, number>;
  clearPendingQuestionForChat: (cacheKey: string) => void;
  clearPendingAuthorizationForChat: (cacheKey: string) => void;
  markQuestionCallHandled: (cacheKey: string, messageId: string, callID: string) => void;
  clearAllPendingQuestions: () => void;
  ensureSession: () => Promise<string>;
  createNewSession: () => Promise<string | undefined>;
  sendCommandMessage: (content: string) => Promise<void>;
  sendErrorMessage: (content: string) => Promise<void>;
  sendUnsupported: () => Promise<void>;
  isKnownCustomCommand: (name: string) => Promise<boolean | null>;
  sendLocalFile: (filePath: string) => Promise<boolean | null>;
};

export async function handleSlashCommand(ctx: CommandContext): Promise<boolean> {
  const {
    api,
    chatId,
    cacheKey,
    slash,
    normalizedCommand,
    targetSessionId,
    targetAgent,
    shouldCreateNew,
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
    clearPendingQuestionForChat,
    clearPendingAuthorizationForChat,
    clearAllPendingQuestions,
    ensureSession,
    createNewSession,
    sendCommandMessage,
    sendUnsupported,
    isKnownCustomCommand,
    sendLocalFile,
  } = ctx;
  bridgeLogger.info(
    `[Command] adapter=${ctx.adapterKey} chat=${ctx.chatId} cmd=/${slash.command} normalized=${normalizedCommand || '-'} args="${slash.arguments || ''}"`,
  );

  if (normalizedCommand === 'help') {
    const res = await api.command.list();
    const list = asNamedRecords(toApiArray(res, ['commands', 'items', 'list']));

    const lines: string[] = [];
    lines.push('## Command');
    lines.push('### Help');
    lines.push('/help - 查看命令与用法');
    lines.push('/models - 查看可用模型（/models <序号> 切换）');
    lines.push('/status - 查看桥接运行状态（PID/启动时间）');
    lines.push('/new - 新建会话并切换');
    lines.push('/rename <title> - 重命名当前会话');
    lines.push('/abort - 强制终止当前会话生成');
    lines.push('/reset (/restart) - 清空桥接运行态并新建会话');
    lines.push('/sessions - 列出会话（用 /sessions <id> 或 /sessions <序号> 切换）');
    lines.push('/sessions delete 1,2,3 - 批量删除会话（序号或id）');
    lines.push('/sessions delete all - 删除全部会话，仅保留当前会话');
    lines.push('/maxFileSize <xmb> - 设置上传文件大小限制（默认10MB）');
    lines.push('/maxFileRetry <n> - 设置资源下载重试次数（默认3）');
    lines.push('/savefile - 上传并保存文件到本地（不经过大模型）');
    lines.push('/sendfile <path> - 直接通过 Bot 回传本地文件（强触发）');
    lines.push('/share - 分享当前会话');
    lines.push('/unshare - 取消分享');
    lines.push('/compact - 压缩/总结当前会话');
    lines.push('/init - 初始化项目（生成 AGENTS.md）');
    lines.push('/agent - 列出 Agents');
    lines.push('/agent <序号|name> - 切换 Agent（序号或精确名称）');

    if (list.length > 0) {
      lines.push('### Custom Commands');
      list.forEach(cmd => {
        if (!cmd.name) return;
        const desc = cmd.description ? `- ${cmd.description}` : '';
        lines.push(`/${cmd.name} ${desc}`);
      });
    }
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'status') {
    const pid = process.pid;
    const startedAtMs = Date.now() - Math.floor(process.uptime() * 1000);
    const startedAt = new Date(startedAtMs).toISOString();
    const uptimeSec = Math.floor(process.uptime());
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeRemainSec = uptimeSec % 60;
    const currentSession = sessionCache.get(cacheKey) || '-';
    const currentAgent = chatAgent.get(cacheKey) || '-';
    const currentModel = chatModel.get(cacheKey);
    const currentModelText = currentModel
      ? currentModel.name || `${currentModel.providerID}/${currentModel.modelID}`
      : '-';

    const lines: string[] = [];
    lines.push('## Command');
    lines.push('### Bridge Status');
    lines.push(`- session: ${currentSession}`);
    lines.push(`- agent: ${currentAgent}`);
    lines.push(`- model: ${currentModelText}`);
    lines.push(`- pid: ${pid}`);
    lines.push(`- startedAt: ${startedAt}`);
    lines.push(`- uptime: ${uptimeMin}m ${uptimeRemainSec}s`);
    lines.push(`- node: ${process.version}`);
    lines.push(`- platform: ${process.platform}/${process.arch}`);
    lines.push(`- logFile: ${getBridgeLogFilePath()}`);
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'models') {
    const res = await api.config.providers();
    const { providers, defaults } = parseProvidersResponse(res);

    if (!Array.isArray(providers) || providers.length === 0) {
      await sendCommandMessage('暂无可用模型信息。');
      return true;
    }

    if (slash.arguments) {
      const arg = slash.arguments.trim();
      const m = arg.match(/^(\d+)\.(\d+)$/);
      if (!m) {
        await sendCommandMessage('❌ 无效序号，请使用 /models 1.2');
        return true;
      }
      const pIdx = Number(m[1]) - 1;
      const mIdx = Number(m[2]) - 1;
      if (pIdx < 0 || mIdx < 0 || pIdx >= providers.length) {
        await sendCommandMessage(`❌ 无效序号: ${arg}`);
        return true;
      }
      const p = providers[pIdx];
      const modelKeys = Object.keys(p?.models || {});
      if (mIdx >= modelKeys.length) {
        await sendCommandMessage(`❌ 无效序号: ${arg}`);
        return true;
      }
      const key = modelKeys[mIdx];
      const model = p.models?.[key];
      const modelId = model?.id;
      const providerID = model?.providerID || p?.id;
      if (!modelId) {
        await sendCommandMessage(`❌ 模型ID缺失: ${arg}`);
        return true;
      }
      if (!providerID) {
        await sendCommandMessage(`❌ ProviderID缺失: ${arg}`);
        return true;
      }

      chatModel.set(cacheKey, {
        providerID,
        modelID: modelId,
        name: model?.name,
      });

      const sessionId = await ensureSession();
      await api.session.command({
        path: { id: sessionId },
        body: { command: 'model', arguments: modelId },
      });
      await sendCommandMessage(`✅ 已切换模型: ${model?.name || modelId} (${providerID})`);
      return true;
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

    providers.forEach((p, index) => {
      Object.keys(p.models).forEach((key, idx) => {
        lines.push(`${index + 1}.${idx + 1}. ${p.models[key].name} (${p.models[key].id})`);
      });
    });

    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'maxfilesize') {
    const current = chatMaxFileSizeMb.get(chatId) ?? DEFAULT_MAX_FILE_MB;
    if (!slash.arguments) {
      await sendCommandMessage(`当前文件大小限制：${current}MB`);
      return true;
    }
    const m = slash.arguments.trim().match(/(\d+(?:\.\d+)?)/);
    const value = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(value) || value <= 0) {
      await sendCommandMessage('❌ 请输入有效数值，例如 /maxFileSize 10');
      return true;
    }
    chatMaxFileSizeMb.set(chatId, value);
    await sendCommandMessage(`✅ 已设置文件大小限制：${value}MB`);
    return true;
  }

  if (normalizedCommand === 'maxfileretry') {
    const current = chatMaxFileRetry.get(chatId) ?? DEFAULT_MAX_FILE_RETRY;
    if (!slash.arguments) {
      await sendCommandMessage(`当前重试次数：${current}`);
      return true;
    }
    const m = slash.arguments.trim().match(/(\d+)/);
    const value = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(value) || value < 0) {
      await sendCommandMessage('❌ 请输入有效整数，例如 /maxFileRetry 3');
      return true;
    }
    chatMaxFileRetry.set(chatId, value);
    await sendCommandMessage(`✅ 已设置重试次数：${value}`);
    return true;
  }

  if (normalizedCommand === 'sendfile') {
    const parsedPath = parseSendFilePath(slash.arguments || '');
    if (!parsedPath) {
      await sendCommandMessage('用法：/sendfile <path>');
      return true;
    }
    const ok = await sendLocalFile(parsedPath);
    if (ok === null) {
      await sendCommandMessage('❌ 当前平台暂不支持 /sendfile。');
      return true;
    }
    if (ok) {
      await sendCommandMessage(`✅ 文件已发送：${parsedPath}`);
      return true;
    }
    await sendCommandMessage(`❌ 文件发送失败：${parsedPath}`);
    return true;
  }

  if (normalizedCommand === 'savefile') {
    chatAwaitingSaveFile.set(cacheKey, true);
    await sendCommandMessage('请上传文件，我会直接保存到本地并返回路径（不经过大模型）。');
    return true;
  }

  if (normalizedCommand === 'agent' && targetAgent) {
    if (/^\d+$/.test(targetAgent)) {
      const list = chatAgentList.get(cacheKey) || [];
      const idx = Number(targetAgent) - 1;
      if (idx < 0 || idx >= list.length) {
        await sendCommandMessage(`❌ 无效序号: ${targetAgent}`);
        return true;
      }
      const agent = list[idx];
      chatAgent.set(cacheKey, agent.id);
      await sendCommandMessage(`✅ 已切换 Agent: ${agent.name || agent.id} (${agent.id})`);
      return true;
    }

    const res = await api.app.agents();
    const list = pickUsableAgents(toApiArray(res, ['agents', 'items', 'list']));
    const exact = list.find(a => a.name === targetAgent || a.id === targetAgent);
    if (!exact) {
      await sendCommandMessage(`❌ 未找到 Agent: ${targetAgent}`);
      return true;
    }
    const pickedId = exact.id;
    chatAgent.set(cacheKey, pickedId);
    await sendCommandMessage(`✅ 已切换 Agent: ${exact.name || pickedId} (${pickedId})`);
    return true;
  }

  if (normalizedCommand === 'agent' && !targetAgent) {
    const res = await api.app.agents();
    const list = pickUsableAgents(toApiArray(res, ['agents', 'items', 'list']));
    if (list.length === 0) {
      await sendCommandMessage('暂无可用 Agent。');
      return true;
    }
    const agents = list.slice(0, 20);
    chatAgentList.set(cacheKey, agents);
    const lines = ['## Command', '### Agents', '请输入 /agent <序号> 或 <name> 切换：'];
    const current = chatAgent.get(cacheKey);
    if (current) lines.push(`当前: ${current}`);
    agents.forEach((a, idx) => {
      lines.push(`${idx + 1}. ${a.name} (${a.id})`);
    });
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'sessions' && !targetSessionId) {
    const args = slash.arguments.trim();
    const del = parseSessionDeleteArgs(args);
    if (del.deleteAll || del.refs.length > 0) {
      const listRes = await api.session.list({});
      const sessions = toSessionList(toApiArray(listRes, ['sessions', 'items', 'list']));
      if (sessions.length === 0) {
        await sendCommandMessage('暂无会话可删除。');
        return true;
      }

      const currentSessionId = sessionCache.get(cacheKey) || (await ensureSession());
      const targets = del.deleteAll
        ? sessions.map(s => s.id).filter(id => id !== currentSessionId)
        : resolveSessionRefs(del.refs, sessions).filter(id => id !== currentSessionId);

      if (targets.length === 0) {
        await sendCommandMessage('没有可删除的会话（当前会话会被保留）。');
        return true;
      }

      const failed: string[] = [];
      for (const id of targets) {
        try {
          await api.session.delete({ path: { id } });
          sessionToAdapterKey.delete(id);
          sessionToCtx.delete(id);
        } catch {
          failed.push(id);
        }
      }

      chatSessionList.set(
        cacheKey,
        sessions.filter(s => s.id === currentSessionId || !targets.includes(s.id)),
      );

      const okCount = targets.length - failed.length;
      const lines = [`✅ 已删除会话 ${okCount} 个。`];
      if (failed.length > 0) lines.push(`❌ 删除失败 ${failed.length} 个：${failed.join(', ')}`);
      if (del.deleteAll) lines.push(`保留当前会话：${currentSessionId}`);
      await sendCommandMessage(lines.join('\n'));
      return true;
    }

    const res = await api.session.list({});
    const sessions = asNamedRecords(toApiArray(res, ['sessions', 'items', 'list']));
    if (sessions.length === 0) {
      await sendCommandMessage('暂无会话，请使用 /new 创建。');
      return true;
    }
    const list = sessions
      .slice(0, 20)
      .map(s => ({ id: s.id, title: s.title || 'Untitled' }))
      .filter((s): s is { id: string; title: string } => Boolean(s.id));
    chatSessionList.set(cacheKey, list);
    const lines = ['## Command', '### Sessions', '请输入 /sessions <序号> 切换：'];
    list.forEach((s, idx) => {
      lines.push(`${idx + 1}. ${s.title}`);
    });
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'sessions' && targetSessionId) {
    let targetId = targetSessionId;
    if (/^\d+$/.test(targetSessionId)) {
      const list = chatSessionList.get(cacheKey) || [];
      const idx = Number(targetSessionId) - 1;
      if (idx >= 0 && idx < list.length) {
        targetId = list[idx].id;
      } else {
        await sendCommandMessage(`❌ 无效序号: ${targetSessionId}`);
        return true;
      }
    }
    sessionCache.set(cacheKey, targetId);
    sessionToAdapterKey.set(targetId, ctx.adapterKey);
    sessionToCtx.set(targetId, { chatId: ctx.chatId, senderId: ctx.senderId });
    chatAgent.delete(cacheKey);
    chatModel.delete(cacheKey);
    clearPendingQuestionForChat(cacheKey);
    clearPendingAuthorizationForChat(cacheKey);
    await sendCommandMessage(`✅ 已切换到会话: ${targetId}`);
    return true;
  }

  if (normalizedCommand === 'share') {
    const sessionId = await ensureSession();
    const res = await api.session.share({ path: { id: sessionId } });
    const url = extractShareUrl(res);
    await sendCommandMessage(url ? `✅ 分享链接: ${url}` : '✅ 已分享会话。');
    return true;
  }

  if (normalizedCommand === 'unshare') {
    const sessionId = await ensureSession();
    await api.session.unshare({ path: { id: sessionId } });
    await sendCommandMessage('✅ 已取消分享。');
    return true;
  }

  if (normalizedCommand === 'compact') {
    const sessionId = await ensureSession();
    await api.session.summarize({ path: { id: sessionId } });
    await sendCommandMessage('✅ 已触发会话压缩。');
    return true;
  }

  if (normalizedCommand === 'init') {
    const sessionId = await ensureSession();
    await api.session.init({ path: { id: sessionId } });
    await sendCommandMessage('✅ 已触发初始化（AGENTS.md）。');
    return true;
  }

  if (normalizedCommand === 'rename') {
    const nextTitle = slash.arguments.trim();
    if (!nextTitle) {
      await sendCommandMessage('用法：/rename <新会话名称>');
      return true;
    }

    const sessionId = await ensureSession();
    const listRes = await api.session.list({});
    const sessions = toSessionList(toApiArray(listRes, ['sessions', 'items', 'list']));
    const uniqueTitle = ensureUniqueSessionTitle(nextTitle, sessions, sessionId);

    await api.session.update({
      path: { id: sessionId },
      body: { title: uniqueTitle },
    });

    const list = chatSessionList.get(cacheKey);
    if (list && list.length > 0) {
      const hit = list.find(item => item.id === sessionId);
      if (hit) hit.title = uniqueTitle;
    }

    if (uniqueTitle !== nextTitle) {
      await sendCommandMessage(`✅ 会话名重复，已自动重命名为：${uniqueTitle}`);
      return true;
    }

    await sendCommandMessage(`✅ 已重命名当前会话：${uniqueTitle}`);
    return true;
  }

  if (normalizedCommand === 'abort') {
    const sessionId = await ensureSession();
    await api.session.abort({ path: { id: sessionId } });
    await sendCommandMessage(`🛑 已请求终止当前会话生成：${sessionId}`);
    return true;
  }

  if (normalizedCommand === 'new') {
    clearPendingQuestionForChat(cacheKey);
    clearPendingAuthorizationForChat(cacheKey);
    const sessionId = await createNewSession();
    if (sessionId) {
      await sendCommandMessage(`✅ 已切换到新会话: ${sessionId}`);
    } else {
      await sendCommandMessage('❌ 新会话创建失败，请稍后重试。');
    }
    return true;
  }

  if (normalizedCommand === 'restart') {
    sessionCache.clear();
    sessionToAdapterKey.clear();
    sessionToCtx.clear();
    chatAgent.clear();
    chatModel.clear();
    chatSessionList.clear();
    chatAgentList.clear();
    chatAwaitingSaveFile.clear();
    chatMaxFileSizeMb.clear();
    chatMaxFileRetry.clear();
    clearAllPendingQuestions();
    clearPendingAuthorizationForChat(cacheKey);

    if (globalState.__bridge_progress_msg_ids) {
      globalState.__bridge_progress_msg_ids.clear();
    }
    if (globalState.__feishu_processed_ids) {
      globalState.__feishu_processed_ids.clear();
    }

    const sessionId = await createNewSession();
    if (sessionId) {
      await sendCommandMessage(`✅ 桥接系统已重置（当前会话: ${sessionId}）`);
    } else {
      await sendCommandMessage('⚠️ 桥接状态已清空，但新会话创建失败，请重试 /new');
    }
    return true;
  }

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
  if (unsupportedCommands.has(normalizedCommand || '')) {
    await sendUnsupported();
    return true;
  }

  const sessionId = await ensureSession();
  const isCustom = await isKnownCustomCommand(slash.command);
  if (isCustom === false) {
    await sendCommandMessage(`❌ 无效指令: /${slash.command}`);
    return true;
  }
  await api.session.command({
    path: { id: sessionId },
    body: { command: slash.command, arguments: slash.arguments },
  });
  bridgeLogger.info(
    `[Command] adapter=${ctx.adapterKey} session=${sessionId} sent=/${slash.command}`,
  );
  return true;
}
