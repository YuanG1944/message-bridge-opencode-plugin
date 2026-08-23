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

function containsAny(token: string, terms: string[]): boolean {
  return terms.some(term => token === term || token.includes(term));
}

export function parseAuthorizationReply(
  value: string
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

  const allowOnce = new Set(['1', 'once', 'allow once', '允许一次', '本次允许', '单次允许']);
  if (allowOnce.has(token) || containsAny(token, ['允许一次', '本次允许', 'allow once', 'once']))
    return 'allow_once';

  const allowAlways = new Set(['2', 'always', 'always allow', '始终允许', '总是允许', '永久允许']);
  if (
    allowAlways.has(token) ||
    containsAny(token, ['始终允许', '总是允许', 'always allow', 'always'])
  )
    return 'allow_always';

  const reject = new Set(['3', 'reject', 'deny', '拒绝', '不允许']);
  if (reject.has(token) || containsAny(token, ['拒绝', 'deny', 'reject']))
    return 'reject_permission';

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
  if (resumeSet.has(token) || containsAny(token, ['继续原会话', 'resume', 'continue', '已授权']))
    return 'resume_blocked';

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
  if (newSet.has(token) || containsAny(token, ['新话题', '新会话', 'start new']))
    return 'start_new_session';

  return 'unknown';
}

export function renderAuthorizationPrompt(state: PendingAuthorizationState): string {
  const lines: string[] = [];
  lines.push('## Authorization');
  if (state.mode === 'permission_request') {
    lines.push('OpenCode is requesting permission. Choose one:');
    if (state.permissionTitle) lines.push(`Permission: ${state.permissionTitle}`);
    if (state.permissionType) lines.push(`Type: ${state.permissionType}`);
    if (state.permissionPattern) {
      const p = Array.isArray(state.permissionPattern)
        ? state.permissionPattern.join(', ')
        : state.permissionPattern;
      if (p) lines.push(`Scope: ${p}`);
    }
    lines.push('');
    lines.push('1. Allow once');
    lines.push('2. Always allow');
    lines.push('3. Deny');
    lines.push('');
    lines.push('If you do not want to handle this authorization, just send a new topic and I will continue in a new session.');
    return lines.join('\n');
  }

  lines.push('This session requires you to complete permission authorization in the OpenCode web UI.');
  if (state.blockedReason) {
    lines.push(`Reason: ${state.blockedReason}`);
  }
  lines.push('');
  lines.push('Reply with:');
  lines.push('1. Authorized, continue this session');
  lines.push('2. Not now; switch to a new session');
  lines.push('');
  lines.push('If you send a new topic directly, I will default to continuing in a new session.');
  return lines.join('\n');
}

export function renderAuthorizationReplyHint(): string {
  return 'Reply with the number shown. Permission requests accept `1/2/3`; blocked sessions accept `1/2`. You can also just send a new topic.';
}

export function renderAuthorizationStatus(
  mode:
    | 'resume'
    | 'switch-new'
    | 'timeout'
    | 'still-blocked'
    | 'permission-once'
    | 'permission-always'
    | 'permission-reject'
): string {
  if (mode === 'permission-once') {
    return '## Status\n✅ Authorized: allowed once. Continuing.';
  }
  if (mode === 'permission-always') {
    return '## Status\n✅ Authorized: always allowed. Continuing.';
  }
  if (mode === 'permission-reject') {
    return '## Status\n🛑 Permission request denied.';
  }
  if (mode === 'resume') {
    return '## Status\n✅ Received. Continuing in the original session.';
  }
  if (mode === 'switch-new') {
    return '## Status\n✅ Detected a new topic; switched to a new session.';
  }
  if (mode === 'still-blocked') {
    return '## Status\n⚠️ This session is still waiting for web authorization. Complete it in the OpenCode UI, or reply `2` to switch to a new session.';
  }
  return '## Status\n⏰ Authorization wait timed out and was cancelled. Subsequent messages will be handled as new input.';
}
