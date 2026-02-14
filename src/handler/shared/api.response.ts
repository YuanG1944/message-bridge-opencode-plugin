type UnknownRecord = Record<string, unknown>;

const ENVELOPE_KEYS = ['data', 'result', 'payload', 'response', 'body'] as const;
const DEFAULT_ARRAY_KEYS = [
  'items',
  'list',
  'rows',
  'sessions',
  'commands',
  'agents',
  'providers',
  'models',
] as const;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export function readString(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

export function unwrapApiEnvelope(value: unknown, maxDepth = 4): unknown {
  let current = value;
  let depth = maxDepth;
  while (depth > 0 && isRecord(current)) {
    let moved = false;
    for (const key of ENVELOPE_KEYS) {
      if (key in current) {
        const next = current[key];
        if (next !== undefined) {
          current = next;
          moved = true;
          break;
        }
      }
    }
    if (!moved) break;
    depth--;
  }
  return current;
}

export function toApiRecord(value: unknown): UnknownRecord | null {
  const unwrapped = unwrapApiEnvelope(value);
  return isRecord(unwrapped) ? unwrapped : null;
}

export function toApiArray(value: unknown, preferredKeys: string[] = []): unknown[] {
  const unwrapped = unwrapApiEnvelope(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (!isRecord(unwrapped)) return [];

  const keys = [...preferredKeys, ...DEFAULT_ARRAY_KEYS];
  for (const key of keys) {
    const direct = unwrapped[key];
    if (Array.isArray(direct)) return direct;
    const nested = unwrapApiEnvelope(direct, 2);
    if (Array.isArray(nested)) return nested;
  }

  return [];
}

export function extractErrorMessage(err: unknown): string | undefined {
  if (typeof err === 'string') return err.trim() || undefined;
  if (!isRecord(err)) return undefined;

  const direct = readString(err, 'message');
  if (direct) return direct;

  const data = toApiRecord(err.data);
  const dataMsg = readString(data, 'message', 'msg', 'error');
  if (dataMsg) return dataMsg;

  const response = toApiRecord(err.response);
  const responseMsg = readString(response, 'message', 'statusText');
  if (responseMsg) return responseMsg;

  const responseData = response ? toApiRecord(response.data) : null;
  const responseDataMsg = readString(responseData, 'message', 'msg', 'error');
  if (responseDataMsg) return responseDataMsg;

  const nestedError = toApiRecord(err.error);
  const nestedMsg = readString(nestedError, 'message', 'msg');
  if (nestedMsg) return nestedMsg;

  return undefined;
}
