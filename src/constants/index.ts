// src/constants/index.ts

export const AGENT_LARK = 'lark-bridge';
export const AGENT_IMESSAGE = 'imessage-bridge';
export const AGENT_TELEGRAM = 'telegram-bridge';
export const AGENT_QQ = 'qq-bridge';

export const BRIDGE_AGENT_IDS = [AGENT_LARK, AGENT_IMESSAGE, AGENT_TELEGRAM, AGENT_QQ] as const;

export const LOADING_EMOJI = 'Typing';

export const UPDATE_INTERVAL = 900;
export const TELEGRAM_UPDATE_INTERVAL = 250;

export const MAX_REASONING_CHARS = 4000;
export const MAX_TEXT_CHARS = 16000;
export const MAX_TOOL_OUTPUT_CHARS = 4000;
export const MAX_TOOL_INPUT_CHARS = 2000;

export const SAFE_MAX_REASONING = 8000;
export const SAFE_MAX_TEXT = 24000;
export const SAFE_MAX_TOOL_INPUT = 4000;
export const SAFE_MAX_TOOL_OUTPUT = 8000;

export const BRIDGE_FEISHU_RESPONSE_TIMEOUT_MS = 60000;
