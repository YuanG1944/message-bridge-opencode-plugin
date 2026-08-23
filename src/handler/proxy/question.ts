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

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
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

function looksLikeFreeTextQuestion(
  question: string,
  id: string,
  header: string,
): boolean {
  const text = `${question}\n${id}\n${header}`.toLowerCase();
  return (
    text.includes('workspace_id') ||
    text.includes('worksapce_id') ||
    text.includes('workspace id') ||
    text.includes('intent scheduler')
  );
}

function normalizeQuestionItem(item: unknown, index: number): NormalizedQuestionItem | null {
  item = parseJsonMaybe(item);
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
  const idRaw = normalizeString(item.id);
  const header = normalizeString(item.header) || normalizeString(item.group);
  const freeText =
    options.length === 0 ||
    item.freeText === true ||
    item.allow_text === true ||
    item.allowFreeText === true ||
    item.textInput === true ||
    item.text_input === true ||
    normalizeString(item.mode).toLowerCase() === 'input' ||
    normalizeString(item.type).toLowerCase() === 'input' ||
    normalizeString(item.inputType).toLowerCase() === 'text' ||
    looksLikeFreeTextQuestion(question, idRaw || `q${index + 1}`, header);

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
  const parsedInput = parseJsonMaybe(input);
  const root = isRecord(parsedInput) ? parsedInput : null;
  const inputRecord = root?.input && isRecord(root.input) ? (root.input as Record<string, unknown>) : null;
  const payloadRecord =
    root?.payload && isRecord(root.payload) ? (root.payload as Record<string, unknown>) : null;
  const dataRecord = root?.data && isRecord(root.data) ? (root.data as Record<string, unknown>) : null;
  const argsRecord =
    root?.arguments && isRecord(root.arguments)
      ? (root.arguments as Record<string, unknown>)
      : root?.args && isRecord(root.args)
        ? (root.args as Record<string, unknown>)
        : root?.params && isRecord(root.params)
          ? (root.params as Record<string, unknown>)
          : null;
  const questionsRaw = Array.isArray(input)
    ? input.map(parseJsonMaybe)
    : Array.isArray(root?.questions)
      ? (root?.questions as unknown[])
      : Array.isArray(root?.question)
        ? (root?.question as unknown[])
        : Array.isArray(root?.options) &&
            (root?.question || root?.prompt || root?.title || root?.text || root?.label)
          ? [root]
          : Array.isArray(inputRecord?.questions)
            ? (inputRecord?.questions as unknown[])
            : Array.isArray(payloadRecord?.questions)
              ? (payloadRecord?.questions as unknown[])
              : Array.isArray(dataRecord?.questions)
                ? (dataRecord?.questions as unknown[])
                : Array.isArray(argsRecord?.questions)
                  ? (argsRecord?.questions as unknown[])
                  : Array.isArray(argsRecord?.question)
                    ? (argsRecord?.question as unknown[])
                    : Array.isArray(argsRecord?.options) &&
                        (argsRecord?.question ||
                          argsRecord?.prompt ||
                          argsRecord?.title ||
                          argsRecord?.text ||
                          argsRecord?.label)
                      ? [argsRecord]
        : root?.question
          ? [root.question]
          : inputRecord && Array.isArray(inputRecord.questions)
            ? (inputRecord.questions as unknown[])
            : inputRecord && inputRecord.question
              ? [inputRecord.question]
              : payloadRecord && payloadRecord.question
                ? [payloadRecord.question]
                : dataRecord && dataRecord.question
                  ? [dataRecord.question]
                  : argsRecord && argsRecord.question
                    ? [argsRecord.question]
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
  const hasOptions = question.options.length > 0;
  if (question.freeText && !hasOptions) {
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

function resolveQuestionSelection(
  question: NormalizedQuestionItem,
  raw: string,
): {
  selectedIndex: number;
  selectedLabel: string;
} | null {
  if (!question.multiple) return resolveSelection(question, raw);

  const pieces = raw
    .split(/[|+/、，,;；\n]+/)
    .map(s => normalizeString(s))
    .filter(Boolean);
  if (pieces.length === 0) return null;

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const one = resolveSelection(question, piece);
    if (!one) return null;
    const key = normalizeToken(one.selectedLabel);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(one.selectedLabel);
  }
  if (labels.length === 0) return null;
  return {
    selectedIndex: -1,
    selectedLabel: labels.join(' | '),
  };
}

function splitInputTokens(raw: string): string[] {
  return raw
    .split(/[\n,;；，]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function buildDeterministicAnswer(
  question: NormalizedQuestionItem,
  questionIndex: number,
): ResolvedQuestionAnswer | null {
  if (question.options.length !== 1) return null;
  return {
    questionId: question.id,
    questionIndex,
    selectedIndex: 0,
    selectedLabel: question.options[0].label,
    raw: 'auto-single-option',
  };
}

export function parseUserReply(
  text: string,
  state: PendingQuestionState,
): { ok: true; answers: ResolvedQuestionAnswer[] } | { ok: false; reason: string } {
  const raw = normalizeString(text);
  if (!raw) return { ok: false, reason: 'empty' };

  const questions = state.payload.questions;
  if (questions.length === 1) {
    const selected = resolveQuestionSelection(questions[0], raw);
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

    const selected = resolveQuestionSelection(questions[questionIndex], m[2]);
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
      const selected = resolveQuestionSelection(questions[i], tokens[i]);
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

  const unresolved = questions
    .map((_, i) => i)
    .filter(i => !answers[i]);
  const unresolvedDeterministic = unresolved.filter(i => buildDeterministicAnswer(questions[i], i));
  const unresolvedVariable = unresolved.filter(i => !buildDeterministicAnswer(questions[i], i));

  // Allow partial reply when all remaining questions are deterministic single-option picks.
  for (const i of unresolvedDeterministic) {
    const auto = buildDeterministicAnswer(questions[i], i);
    if (auto) answers[i] = auto;
  }
  if (answers.every(Boolean)) {
    return { ok: true, answers };
  }

  // Map tokens to non-deterministic unanswered questions in order.
  if (tokens.length === unresolvedVariable.length) {
    for (let i = 0; i < unresolvedVariable.length; i++) {
      const qIdx = unresolvedVariable[i];
      const selected = resolveQuestionSelection(questions[qIdx], tokens[i]);
      if (!selected) return { ok: false, reason: `unmatched-q${qIdx + 1}` };
      answers[qIdx] = {
        questionId: questions[qIdx].id,
        questionIndex: qIdx,
        selectedIndex: selected.selectedIndex,
        selectedLabel: selected.selectedLabel,
        raw: tokens[i],
      };
    }
    for (const i of unresolvedDeterministic) {
      if (answers[i]) continue;
      const auto = buildDeterministicAnswer(questions[i], i);
      if (auto) answers[i] = auto;
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
  if (question.options.length > 0) {
    question.options.forEach((option, idx) => {
      lines.push(`${idx + 1}. ${option.label}`);
      if (option.description) lines.push(`   - ${option.description}`);
    });
    if (question.freeText) {
      lines.push('You can also type a custom answer.');
    }
    return lines;
  }
  if (question.freeText) {
    lines.push('Please reply directly with your answer (text input).');
    return lines;
  }
  return lines;
}

export function renderQuestionPrompt(state: PendingQuestionState): string {
  const hasFreeText = state.payload.questions.some(q => q.freeText);
  const hasAutoSingleOption = state.payload.questions.some(q => !q.freeText && q.options.length === 1);
  const lines: string[] = [];
  lines.push('## Question');
  lines.push(
    hasFreeText
      ? 'This turn needs your answer. Reply directly:'
      : 'This turn needs you to pick an option. Reply directly:',
  );
  lines.push('');

  state.payload.questions.forEach((q, idx) => {
    lines.push(...renderQuestionBlock(q, idx));
    lines.push('');
  });
  if (hasAutoSingleOption) {
    lines.push('Note: single-option questions are selected automatically; you only answer text/multi-option questions.');
    lines.push('');
  }

  if (state.payload.questions.length === 1) {
    const q = state.payload.questions[0];
    if (q.freeText) {
      lines.push('Example reply: `your workspace_id`');
    } else {
      lines.push('Example reply: `1` or option text');
    }
  } else {
    lines.push('Example reply: `Q1:2,Q2:your answer` or `2,your answer`');
  }
  lines.push('No reply within 15 minutes automatically cancels this question.');

  return lines.join('\n');
}

export function renderReplyHint(state: PendingQuestionState): string {
  const hasFreeText = state.payload.questions.some(q => q.freeText);
  const hasOptions = state.payload.questions.some(q => q.options.length > 0);
  if (hasFreeText && hasOptions) {
    if (state.payload.questions.length === 1) {
      return 'I did not recognize your answer. Reply with the option number/text, or type a custom answer.';
    }
    return 'I did not recognize your answer. Reply like `Q1:1,Q2:your answer`; choice questions also accept custom answers.';
  }
  if (hasFreeText) {
    if (state.payload.questions.length === 1) {
      return 'I did not recognize your answer. Reply directly with the text answer.';
    }
    return 'I did not recognize your answer. Reply `Q1:2,Q2:your answer` (or in order `2,your answer`).';
  }
  if (state.payload.questions.length === 1) {
    return 'I did not recognize your answer. Reply `1`/`2`/`3` or the option text.';
  }
  return 'I did not recognize your answer. Reply `Q1:2,Q2:1` (or in order `2,1`), or use the option text.';
}

export function renderAnswerSummary(
  state: PendingQuestionState,
  answers: ResolvedQuestionAnswer[],
  source: 'user' | 'timeout',
): string {
  const lines: string[] = [];
  lines.push('## Status');
  lines.push(
    source === 'timeout' ? '⏰ Timed out; this question was cancelled.' : '✅ Got your selection. Continuing.',
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
