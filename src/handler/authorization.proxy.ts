import type { FilePartInput, TextPartInput } from '@opencode-ai/sdk';

export const AUTH_TIMEOUT_MS = 15 * 60 * 1000;

export type PendingAuthorizationState = {
  mode: 'permission_request' | 'session_blocked';
  key: string;
  adapterKey: string;
  chatId: string;
  senderId: string;
  sessionId: string;
  permissionID?: string;
  permissionType?: string;
  permissionTitle?: string;
  permissionPattern?: string | Array<string>;
  blockedReason: string;
  source: 'bridge.incoming' | 'bridge.question.resume';
  deferredParts?: Array<TextPartInput | FilePartInput>;
  createdAt: number;
  dueAt: number;
};

function normalizeToken(value: string): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '');
}

export function parseAuthorizationReply(
  value: string,
):
  | 'resume_blocked'
  | 'start_new_session'
  | 'allow_once'
  | 'allow_always'
  | 'reject_permission'
  | 'unknown'
  | 'empty' {
  const token = normalizeToken(value);
  if (!token) return 'empty';

  const allowOnce = new Set([
    '1',
    'once',
    'allow once',
    '允许一次',
    '本次允许',
    '单次允许',
  ]);
  if (allowOnce.has(token)) return 'allow_once';

  const allowAlways = new Set([
    '2',
    'always',
    'always allow',
    '始终允许',
    '总是允许',
    '永久允许',
  ]);
  if (allowAlways.has(token)) return 'allow_always';

  const reject = new Set([
    '3',
    'reject',
    'deny',
    '拒绝',
    '不允许',
  ]);
  if (reject.has(token)) return 'reject_permission';

  const resumeSet = new Set([
    'y',
    'yes',
    'ok',
    'okay',
    'continue',
    'resume',
    '继续',
    '继续原会话',
    '已授权',
    '授权好了',
    '授权完成',
    '好了',
    '完成',
  ]);
  if (resumeSet.has(token)) return 'resume_blocked';

  const newSet = new Set([
    '2',
    'new',
    'new session',
    'new topic',
    'skip',
    'start new',
    '新会话',
    '新话题',
    '跳过',
    '先聊别的',
    '换个话题',
  ]);
  if (newSet.has(token)) return 'start_new_session';

  return 'unknown';
}

export function renderAuthorizationPrompt(state: PendingAuthorizationState): string {
  const lines: string[] = [];
  lines.push('## Question');
  if (state.mode === 'permission_request') {
    lines.push('OpenCode 请求权限，请选择：');
    if (state.permissionTitle) lines.push(`权限：${state.permissionTitle}`);
    if (state.permissionType) lines.push(`类型：${state.permissionType}`);
    if (state.permissionPattern) {
      const p = Array.isArray(state.permissionPattern)
        ? state.permissionPattern.join(', ')
        : state.permissionPattern;
      if (p) lines.push(`范围：${p}`);
    }
    lines.push('');
    lines.push('1. 允许一次');
    lines.push('2. 始终允许');
    lines.push('3. 拒绝');
    lines.push('');
    lines.push('如果你不想处理授权、直接发新话题，我会切到新会话继续。');
    return lines.join('\n');
  }

  lines.push('检测到当前会话需要你在 OpenCode 网页完成权限授权。');
  if (state.blockedReason) {
    lines.push(`原因：${state.blockedReason}`);
  }
  lines.push('');
  lines.push('请回复：');
  lines.push('1. 已授权，继续当前会话');
  lines.push('2. 先不授权，切换新会话继续');
  lines.push('');
  lines.push('如果你直接发送新话题，我会默认切换到新会话继续。');
  return lines.join('\n');
}

export function renderAuthorizationReplyHint(): string {
  return '请按提示回复序号。权限请求可回复 `1/2/3`，会话阻塞可回复 `1/2`。也可以直接发送新话题。';
}

export function renderAuthorizationStatus(
  mode:
    | 'resume'
    | 'switch-new'
    | 'timeout'
    | 'still-blocked'
    | 'permission-once'
    | 'permission-always'
    | 'permission-reject',
): string {
  if (mode === 'permission-once') {
    return '## Status\n✅ 已授权：允许一次。继续处理中。';
  }
  if (mode === 'permission-always') {
    return '## Status\n✅ 已授权：始终允许。继续处理中。';
  }
  if (mode === 'permission-reject') {
    return '## Status\n🛑 已拒绝本次权限请求。';
  }
  if (mode === 'resume') {
    return '## Status\n✅ 已收到，继续在原会话处理中。';
  }
  if (mode === 'switch-new') {
    return '## Status\n✅ 检测到你要继续新话题，已切换新会话。';
  }
  if (mode === 'still-blocked') {
    return '## Status\n⚠️ 当前会话仍在等待网页权限授权，请先完成授权，或回复 `2` 切换新会话。';
  }
  return '## Status\n⏰ 超时未确认，本轮授权等待已取消。后续消息将按新输入处理。';
}
