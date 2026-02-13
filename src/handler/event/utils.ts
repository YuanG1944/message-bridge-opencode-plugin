import type { Event } from '@opencode-ai/sdk';

export type EventWithType = { type: Event['type'] | string; properties?: unknown };

export const KNOWN_EVENT_TYPES = new Set<string>([
  'server.instance.disposed',
  'installation.updated',
  'installation.update-available',
  'lsp.client.diagnostics',
  'lsp.updated',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.removed',
  'permission.updated',
  'permission.replied',
  'session.status',
  'session.idle',
  'session.compacted',
  'file.edited',
  'todo.updated',
  'command.executed',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.diff',
  'session.error',
  'file.watcher.updated',
  'vcs.branch.updated',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'server.connected',
  // v2/compat
  'permission.asked',
  'question.asked',
  'question.replied',
  'question.rejected',
]);

export const KNOWN_PART_TYPES = new Set<string>([
  'text',
  'subtask',
  'reasoning',
  'file',
  'tool',
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'agent',
  'retry',
  'compaction',
]);

export function readStringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function unwrapObservedEvent(event: unknown): EventWithType | null {
  const direct = event as { type?: unknown; properties?: unknown; payload?: unknown } | null;
  if (direct && typeof direct.type === 'string') return direct as EventWithType;

  const nested = direct?.payload as { type?: unknown; properties?: unknown } | null;
  if (nested && typeof nested.type === 'string') return nested as EventWithType;

  return null;
}

export function summarizeObservedEvent(event: unknown): Record<string, unknown> {
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
