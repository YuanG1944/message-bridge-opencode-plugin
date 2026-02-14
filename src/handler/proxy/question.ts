import type { ToolPart } from '@opencode-ai/sdk';

export const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

export type NormalizedQuestionOption = {
  label: string;
  description?: string;
};

export type NormalizedQuestionItem = {
  id: string;
  header?: string;
  question: string;
  options: NormalizedQuestionOption[];
  freeText: boolean;
  multiple: boolean;
};

export type NormalizedQuestionPayload = {
  questions: NormalizedQuestionItem[];
};

export type ResolvedQuestionAnswer = {
  questionId: string;
  questionIndex: number;
  selectedIndex: number;
  selectedLabel: string;
  raw: string;
};

export type PendingQuestionState = {
  key: string;
  adapterKey: string;
  chatId: string;
  sessionId: string;
  messageId: string;
  callID: string;
  payload: NormalizedQuestionPayload;
  createdAt: number;
  dueAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionLabel(option: Record<string, unknown>): string {
  return (
    normalizeString(option.label) ||
    normalizeString(option.text) ||
    normalizeString(option.title) ||
    normalizeString(option.value) ||
    normalizeString(option.name)
  );
}

function normalizeQuestionItem(item: unknown, index: number): NormalizedQuestionItem | null {
  if (typeof item === 'string') {
    const question = normalizeString(item);
    if (!question) return null;
    return {
      id: `q${index + 1}`,
      question,
      options: [],
      freeText: true,
      multiple: false,
    };
  }
  if (!isRecord(item)) return null;

  const question =
    normalizeString(item.question) ||
    normalizeString(item.prompt) ||
    normalizeString(item.title) ||
    normalizeString(item.text);
  if (!question) return null;

  const optionsRaw = Array.isArray(item.options)
    ? item.options
    : Array.isArray(item.choices)
      ? item.choices
      : Array.isArray(item.items)
        ? item.items
      : [];
  const options: NormalizedQuestionOption[] = optionsRaw
    .map(option => {
      if (typeof option === 'string') {
        const label = normalizeString(option);
        if (!label) return null;
        return { label };
      }
      if (!isRecord(option)) return null;
      const label = normalizeOptionLabel(option);
      if (!label) return null;
      const description = normalizeString(option.description) || normalizeString(option.detail);
      return {
        label,
        ...(description ? { description } : {}),
      };
    })
    .filter((v): v is NormalizedQuestionOption => v !== null);
  const freeText =
    options.length === 0 ||
    item.freeText === true ||
    item.allow_text === true ||
    item.allowFreeText === true ||
    item.textInput === true ||
    item.text_input === true ||
    normalizeString(item.mode).toLowerCase() === 'input' ||
    normalizeString(item.type).toLowerCase() === 'input' ||
    normalizeString(item.inputType).toLowerCase() === 'text';

  const idRaw = normalizeString(item.id);
  const header = normalizeString(item.header) || normalizeString(item.group);

  return {
    id: idRaw || `q${index + 1}`,
    ...(header ? { header } : {}),
    question,
    options,
    freeText,
    multiple: item.multiple === true,
  };
}

export function extractQuestionPayload(input: unknown): NormalizedQuestionPayload | null {
  const root = isRecord(input) ? input : null;
  const questionsRaw = Array.isArray(input)
    ? input
    : Array.isArray(root?.questions)
      ? (root?.questions as unknown[])
      : Array.isArray(root?.question)
        ? (root?.question as unknown[])
        : root?.question
          ? [root.question]
          : root?.input && isRecord(root.input) && Array.isArray((root.input as Record<string, unknown>).questions)
            ? ((root.input as Record<string, unknown>).questions as unknown[])
            : root?.input && isRecord(root.input) && (root.input as Record<string, unknown>).question
              ? [(root.input as Record<string, unknown>).question]
              : root &&
                    (root.question || root.prompt || root.title || root.text || root.options || root.choices)
                ? [root]
                : [];
  const questions = questionsRaw
    .map((item, idx) => normalizeQuestionItem(item, idx))
    .filter((v): v is NormalizedQuestionItem => v !== null);

  if (questions.length === 0) return null;
  return { questions };
}

export function isQuestionToolPart(part: unknown): part is ToolPart {
  if (!isRecord(part)) return false;
  if (part.type !== 'tool') return false;
  return normalizeString(part.tool).toLowerCase() === 'question';
}

export function isQuestionToolError(part: ToolPart): boolean {
  return normalizeString(part?.state?.status).toLowerCase() === 'error';
}

export function pickDefaultOption(question: NormalizedQuestionItem): {
  selectedIndex: number;
  selectedLabel: string;
} {
  const recommendedIndex = question.options.findIndex(opt => /\(recommended\)/i.test(opt.label));
  const selectedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;
  return {
    selectedIndex,
    selectedLabel: question.options[selectedIndex].label,
  };
}

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSelection(
  question: NormalizedQuestionItem,
  raw: string,
): {
  selectedIndex: number;
  selectedLabel: string;
} | null {
  const token = normalizeString(raw);
  if (!token) return null;
  if (question.freeText && question.options.length === 0) {
    return {
      selectedIndex: -1,
      selectedLabel: token,
    };
  }

  if (/^\d+$/.test(token)) {
    const idx = Number(token) - 1;
    if (idx >= 0 && idx < question.options.length) {
      return {
        selectedIndex: idx,
        selectedLabel: question.options[idx].label,
      };
    }
  }

  const normalized = normalizeToken(token);
  if (!normalized) return null;

  const exact = question.options.findIndex(opt => normalizeToken(opt.label) === normalized);
  if (exact >= 0) {
    return {
      selectedIndex: exact,
      selectedLabel: question.options[exact].label,
    };
  }

  const contains = question.options.findIndex(opt =>
    normalizeToken(opt.label).includes(normalized),
  );
  if (contains >= 0) {
    return {
      selectedIndex: contains,
      selectedLabel: question.options[contains].label,
    };
  }

  if (question.freeText) {
    return {
      selectedIndex: -1,
      selectedLabel: token,
    };
  }

  return null;
}

function splitInputTokens(raw: string): string[] {
  return raw
    .split(/[\n,;；，]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function parseUserReply(
  text: string,
  state: PendingQuestionState,
): { ok: true; answers: ResolvedQuestionAnswer[] } | { ok: false; reason: string } {
  const raw = normalizeString(text);
  if (!raw) return { ok: false, reason: 'empty' };

  const questions = state.payload.questions;
  if (questions.length === 1) {
    const selected = resolveSelection(questions[0], raw);
    if (!selected) return { ok: false, reason: 'unmatched-single' };
    return {
      ok: true,
      answers: [
        {
          questionId: questions[0].id,
          questionIndex: 0,
          selectedIndex: selected.selectedIndex,
          selectedLabel: selected.selectedLabel,
          raw,
        },
      ],
    };
  }

  const answers = new Array<ResolvedQuestionAnswer>(questions.length);
  const tokens = splitInputTokens(raw);

  for (const token of tokens) {
    const m = token.match(/^q?(\d+)\s*[:：=]\s*(.+)$/i);
    if (!m) continue;

    const questionIndex = Number(m[1]) - 1;
    if (questionIndex < 0 || questionIndex >= questions.length) continue;

    const selected = resolveSelection(questions[questionIndex], m[2]);
    if (!selected) return { ok: false, reason: `unmatched-q${questionIndex + 1}` };

    answers[questionIndex] = {
      questionId: questions[questionIndex].id,
      questionIndex,
      selectedIndex: selected.selectedIndex,
      selectedLabel: selected.selectedLabel,
      raw: token,
    };
  }

  if (answers.every(Boolean)) {
    return { ok: true, answers };
  }

  if (tokens.length === questions.length) {
    for (let i = 0; i < questions.length; i++) {
      if (answers[i]) continue;
      const selected = resolveSelection(questions[i], tokens[i]);
      if (!selected) return { ok: false, reason: `unmatched-q${i + 1}` };
      answers[i] = {
        questionId: questions[i].id,
        questionIndex: i,
        selectedIndex: selected.selectedIndex,
        selectedLabel: selected.selectedLabel,
        raw: tokens[i],
      };
    }

    if (answers.every(Boolean)) {
      return { ok: true, answers };
    }
  }

  return { ok: false, reason: 'incomplete-multi' };
}

export function buildDefaultAnswers(state: PendingQuestionState): ResolvedQuestionAnswer[] {
  return state.payload.questions.map((question, idx) => {
    if (question.freeText && question.options.length === 0) {
      return {
        questionId: question.id,
        questionIndex: idx,
        selectedIndex: -1,
        selectedLabel: '',
        raw: 'default',
      };
    }
    const selected = pickDefaultOption(question);
    return {
      questionId: question.id,
      questionIndex: idx,
      selectedIndex: selected.selectedIndex,
      selectedLabel: selected.selectedLabel,
      raw: 'default',
    };
  });
}

function renderQuestionBlock(question: NormalizedQuestionItem, index: number): string[] {
  const lines: string[] = [];
  lines.push(`### Q${index + 1}${question.header ? ` ${question.header}` : ''}`);
  lines.push(question.question);
  if (question.freeText && question.options.length === 0) {
    lines.push('请直接回复你的答案（文本输入）。');
    return lines;
  }
  question.options.forEach((option, idx) => {
    lines.push(`${idx + 1}. ${option.label}`);
    if (option.description) lines.push(`   - ${option.description}`);
  });
  return lines;
}

export function renderQuestionPrompt(state: PendingQuestionState): string {
  const hasFreeText = state.payload.questions.some(q => q.freeText && q.options.length === 0);
  const lines: string[] = [];
  lines.push('## Question');
  lines.push(
    hasFreeText
      ? '检测到本轮需要你回答问题，请直接回复答案：'
      : '检测到本轮需要你选择选项，请直接回复答案：',
  );
  lines.push('');

  state.payload.questions.forEach((q, idx) => {
    lines.push(...renderQuestionBlock(q, idx));
    lines.push('');
  });

  if (state.payload.questions.length === 1) {
    const q = state.payload.questions[0];
    if (q.freeText && q.options.length === 0) {
      lines.push('回复示例：`你的 workspace_id`');
    } else {
      lines.push('回复示例：`1` 或 `选项文本`');
    }
  } else {
    lines.push('回复示例：`Q1:2,Q2:你的答案` 或 `2,你的答案`');
  }
  lines.push('15分钟内未回复将自动取消本轮提问。');

  return lines.join('\n');
}

export function renderReplyHint(state: PendingQuestionState): string {
  const hasFreeText = state.payload.questions.some(q => q.freeText && q.options.length === 0);
  if (hasFreeText) {
    if (state.payload.questions.length === 1) {
      return '未识别你的答案，请直接回复文本答案。';
    }
    return '未识别你的答案，请回复 `Q1:2,Q2:你的答案`（或按顺序 `2,你的答案`）。';
  }
  if (state.payload.questions.length === 1) {
    return '未识别你的答案，请回复 `1`/`2`/`3` 或直接回复选项文本。';
  }
  return '未识别你的答案，请回复 `Q1:2,Q2:1`（或按顺序 `2,1`），也可用选项文本。';
}

export function renderAnswerSummary(
  state: PendingQuestionState,
  answers: ResolvedQuestionAnswer[],
  source: 'user' | 'timeout',
): string {
  const lines: string[] = [];
  lines.push('## Status');
  lines.push(
    source === 'timeout' ? '⏰ 超时，本轮提问已取消。' : '✅ 已收到你的选择，继续处理中。',
  );
  answers.forEach(ans => {
    const q = state.payload.questions[ans.questionIndex];
    lines.push(
      `- Q${ans.questionIndex + 1}${q.header ? ` ${q.header}` : ''}: ${ans.selectedLabel}`,
    );
  });
  return lines.join('\n');
}

export function buildResumePrompt(
  state: PendingQuestionState,
  answers: ResolvedQuestionAnswer[],
  source: 'user' | 'timeout',
): string {
  const payload = {
    type: 'bridge_question_answers',
    source,
    sessionId: state.sessionId,
    messageId: state.messageId,
    questions: answers.map(ans => {
      const q = state.payload.questions[ans.questionIndex];
      return {
        questionId: ans.questionId,
        question: q.question,
        selectedIndex: ans.selectedIndex,
        selectedLabel: ans.selectedLabel,
      };
    }),
  };

  return [
    'Bridge captured the previous question tool input and resolved answers from IM chat.',
    'Use the selections below as the user choices and continue the original task directly.',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}
