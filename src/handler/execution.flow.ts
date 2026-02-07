import { buildDisplayContent } from '../bridge/buffer';
import type { BufferStatus, MessageBuffer } from '../bridge/buffer';

export const FLOW_LOG_PREFIX = '[BridgeFlow]';
const EXECUTION_TO_ANSWER_SPLIT_MIN_TEXT = 120;
type ExecutionMessageBuffer = MessageBuffer & { __executionCarried?: boolean };

function hasSubstantiveAnswerText(buf: ExecutionMessageBuffer): boolean {
  return (buf?.text || '').trim().length > 1;
}

function hasExecutionLikeContent(buf: ExecutionMessageBuffer): boolean {
  return !!(buf?.tools?.size || 0) || !!(buf?.reasoning || '').trim();
}

function isToolCallPhase(buf: ExecutionMessageBuffer): boolean {
  const note = String(buf?.statusNote || '').toLowerCase();
  return note.includes('tool-calls') || note.includes('tool calls');
}

function isTerminalStatus(status: BufferStatus | undefined): boolean {
  return status === 'done' || status === 'error' || status === 'aborted';
}

export function shouldCarryPlatformMessageAcrossAssistantMessages(
  prevBuf: ExecutionMessageBuffer | undefined,
): boolean {
  if (!prevBuf?.platformMsgId) return false;
  if (prevBuf?.status === 'error' || prevBuf?.status === 'aborted') return false;
  if (isToolCallPhase(prevBuf)) return true;
  if (!hasExecutionLikeContent(prevBuf)) return false;
  // Merge only while execution is ongoing and no substantive answer is formed yet.
  return !hasSubstantiveAnswerText(prevBuf);
}

export function carryPlatformMessage(prevBuf: ExecutionMessageBuffer, nextBuf: ExecutionMessageBuffer) {
  nextBuf.platformMsgId = prevBuf.platformMsgId;
  nextBuf.lastDisplayHash = '';
  nextBuf.__executionCarried = true;
  if ((nextBuf.tools?.size || 0) === 0 && (prevBuf.tools?.size || 0) > 0) {
    nextBuf.tools = new Map(prevBuf.tools);
  }
  if (!nextBuf.files?.length && Array.isArray(prevBuf.files) && prevBuf.files.length > 0) {
    nextBuf.files = [...prevBuf.files];
  }
  prevBuf.platformMsgId = null;
}

export function shouldSplitOutFinalAnswer(buffer: ExecutionMessageBuffer): boolean {
  if (!buffer?.platformMsgId || !buffer?.__executionCarried) return false;
  if (isToolCallPhase(buffer)) return false;
  const textLen = (buffer?.text || '').trim().length;
  return textLen >= EXECUTION_TO_ANSWER_SPLIT_MIN_TEXT;
}

export function splitFinalAnswerFromExecution(buffer: ExecutionMessageBuffer) {
  buffer.platformMsgId = null;
  buffer.lastDisplayHash = '';
  buffer.__executionCarried = false;
  // Final answer should be a clean message, not mixed with historical execution context.
  buffer.tools = new Map();
  buffer.reasoning = '';
}

export function buildFinalizedExecutionContent(buffer: ExecutionMessageBuffer): string {
  const finalExecutionView = {
    ...buffer,
    text: '',
    status: 'done' as BufferStatus,
    statusNote: String(buffer.statusNote || 'tool-calls'),
  };
  return buildDisplayContent(finalExecutionView);
}

export function buildPlatformDisplay(buffer: ExecutionMessageBuffer): string {
  // Avoid leaking partial conclusion into execution cards during streaming.
  // Once terminal, always show answer text even if execution context exists.
  if (
    buffer?.__executionCarried &&
    hasExecutionLikeContent(buffer) &&
    hasSubstantiveAnswerText(buffer) &&
    !isTerminalStatus(buffer.status)
  ) {
    return buildDisplayContent({ ...buffer, text: '' });
  }
  return buildDisplayContent(buffer);
}
