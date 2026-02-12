// src/feishu/feishu.renderer.ts
import { sanitizeTemplateMarkers } from '../utils';

type FeishuCard = {
  config?: { wide_screen_mode?: boolean };
  header?: { title: { tag: 'plain_text'; content: string }; template?: string };
  elements: FeishuCardElement[];
};

type FeishuCardElement = Record<string, unknown>;

export type RenderedFile = {
  filename?: string;
  mime?: string;
  url: string;
};

function trimSafe(s: string) {
  return (s || '').trim();
}

function sanitizeCardValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeTemplateMarkers(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(v => sanitizeCardValue(v)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeCardValue(v);
    }
    return out as T;
  }
  return value;
}

function larkMd(content: string) {
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: content },
  };
}

function hr() {
  return { tag: 'hr' };
}

function spacer() {
  return { tag: 'div', text: { tag: 'lark_md', content: ' ' } };
}

function collapsiblePanel(title: string, content: string, expanded = false, borderColor?: string) {
  const c = trimSafe(content);
  if (!c) return null;

  return {
    tag: 'collapsible_panel',
    expanded: expanded,
    background_style: 'grey',
    header: {
      title: { tag: 'plain_text', content: title },
    },
    border: {
      top: true,
      bottom: true,
      ...(borderColor ? { color: borderColor } : {}),
    },
    elements: [larkMd(c)],
  };
}

function splitToolsIntoExecutionPanels(rawTools: string): string[] {
  const raw = trimSafe(rawTools);
  if (!raw) return [];

  const lines = raw.split('\n');

  const stepHeaderIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*###\s*steps?\s+\d+/i.test(lines[i])) stepHeaderIndexes.push(i);
  }
  if (stepHeaderIndexes.length > 0) {
    const panels: string[] = [];
    for (let i = 0; i < stepHeaderIndexes.length; i++) {
      const start = stepHeaderIndexes[i];
      const end = i + 1 < stepHeaderIndexes.length ? stepHeaderIndexes[i + 1] : lines.length;
      const block = trimSafe(lines.slice(start + 1, end).join('\n'));
      if (block) panels.push(block);
    }
    if (panels.length > 0) return panels;
  }

  const toolStartIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*\S+/.test(lines[i])) toolStartIndexes.push(i);
  }
  if (toolStartIndexes.length === 0) return [raw];

  const panels: string[] = [];
  for (let i = 0; i < toolStartIndexes.length; i++) {
    const start = toolStartIndexes[i];
    const end = i + 1 < toolStartIndexes.length ? toolStartIndexes[i + 1] : lines.length;
    const block = trimSafe(lines.slice(start, end).join('\n'));
    if (block) panels.push(block);
  }
  return panels.length > 0 ? panels : [raw];
}

function normalizeSectionTitle(rawTitle: string): string {
  return (rawTitle || '')
    .trim()
    .replace(/[*#:：]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function matchSectionKey(
  rawTitle: string,
): 'thinking' | 'error' | 'command' | 'tools' | 'files' | 'status' | 'authorization' | 'answer' | null {
  const t = normalizeSectionTitle(rawTitle);
  if (!t) return null;

  if (['thinking', 'thought', '思考'].includes(t)) return 'thinking';
  if (['error', '错误'].includes(t)) return 'error';
  if (['command', '命令'].includes(t)) return 'command';
  if (['tool', 'tools', 'step', 'steps', '工具', '步骤', 'tools / steps'].includes(t))
    return 'tools';
  if (['file', 'files', '文件'].includes(t)) return 'files';
  if (['status', '状态'].includes(t)) return 'status';
  if (['authorization', 'auth', '权限', '授权'].includes(t)) return 'authorization';
  if (['answer', '回答'].includes(t)) return 'answer';

  return null;
}

function getStatusWithEmoji(statusText: string): string {
  const s = statusText.toLowerCase();
  const isDone =
    s.includes('done') || s.includes('stop') || s.includes('finish') || s.includes('idle');

  const emoji = isDone ? '✅' : '⚡️';

  const cleanText = statusText.replace(/\n/g, ' | ').slice(0, 100);
  return `${emoji} ${cleanText}`;
}

function splitStatusPaths(statusText: string): { status: string; paths: string[] } {
  const lines = (statusText || '').split('\n');
  const paths: string[] = [];
  const keep: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const p = trimmed.slice(2).trim();
      if (p) {
        paths.push(p);
        continue;
      }
    }
    keep.push(line);
  }

  return { status: keep.join('\n').trim(), paths };
}

function pickHeaderForStatus(statusRaw: string): { title: string; color: string } {
  const statusText = trimSafe(statusRaw).toLowerCase();
  const isFail =
    statusText.includes('失败') ||
    statusText.includes('error') ||
    statusText.includes('fail') ||
    statusText.includes('❌');
  const isSuccess =
    statusText.includes('成功') ||
    statusText.includes('已保存') ||
    statusText.includes('已存在') ||
    statusText.includes('✅') ||
    statusText.includes('🟡');
  const isProcessing =
    statusText.includes('正在处理') ||
    statusText.includes('处理中') ||
    statusText.includes('processing') ||
    statusText.includes('loading') ||
    statusText.includes('⏳');

  if (isFail) return { title: '🚨 Error', color: 'red' };
  if (isSuccess) return { title: '✅ Saved', color: 'green' };
  if (isProcessing) return { title: '⏳ Loading', color: 'orange' };
  return { title: '📝 Status', color: 'blue' };
}

function parseSections(md: string) {
  const sectionMap: Record<string, string> = {
    command: '',
    error: '',
    thinking: '',
    authorization: '',
    answer: '',
    tools: '',
    files: '',
    status: '',
  };

  let cleanMd = md;

  const thinkingBlockRegex = /^(\s*> [^]*?)(?=\n[^>]|$)/;
  const thinkingMatch = md.match(thinkingBlockRegex);

  if (thinkingMatch && !md.includes('## Thinking')) {
    sectionMap.thinking = thinkingMatch[1];
    cleanMd = md.slice(thinkingMatch[0].length);
  }

  const headerRegex = /(?:^|\n)(##+|(?:\*\*))\s*(.*?)(?:(?:\*\*|:)?)(?=\n|$)/g;
  let match;

  const firstMatch = headerRegex.exec(cleanMd);
  if (firstMatch && firstMatch.index > 0) {
    sectionMap.answer = cleanMd.slice(0, firstMatch.index);
  }
  headerRegex.lastIndex = 0;

  while ((match = headerRegex.exec(cleanMd)) !== null) {
    const rawTitle = match[2].toLowerCase().trim();
    const startIndex = match.index + match[0].length;
    const nextMatch = headerRegex.exec(cleanMd);
    const endIndex = nextMatch ? nextMatch.index : cleanMd.length;
    headerRegex.lastIndex = endIndex;

    const content = cleanMd.slice(startIndex, endIndex);

    const sectionKey = matchSectionKey(match[2]);
    if (sectionKey) {
      sectionMap[sectionKey] += content;
    } else {
      sectionMap.answer += `\n\n**${match[2]}**\n${content}`;
    }

    if (!nextMatch) break;
    headerRegex.lastIndex = nextMatch.index;
  }

  if (
    !sectionMap.answer &&
    !sectionMap.command &&
    !sectionMap.error &&
    !sectionMap.thinking &&
    !sectionMap.authorization &&
    !sectionMap.status
  ) {
    sectionMap.answer = cleanMd;
  }

  return sectionMap;
}

export function extractFilesFromHandlerMarkdown(markdown: string): RenderedFile[] {
  const { files } = parseSections(markdown);
  const raw = trimSafe(files);
  if (!raw) return [];

  const lines = raw.split('\n');
  const out: RenderedFile[] = [];
  let current: RenderedFile | null = null;

  const pushCurrent = () => {
    if (current && current.url) out.push(current);
    current = null;
  };

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;

    if (line.startsWith('- ')) {
      pushCurrent();
      const namePart = line.slice(2).trim();
      const match = namePart.match(/^(.*)\s+\((.+)\)$/);
      if (match) {
        current = { filename: match[1], mime: match[2], url: '' };
      } else {
        current = { filename: namePart, url: '' };
      }
      continue;
    }

    if (current && !current.url) {
      current.url = line;
      continue;
    }
  }

  pushCurrent();
  return out;
}

function renderHelpCommand(command: string): FeishuCardElement[] | null {
  const lines = command
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const helpIndex = lines.findIndex(l => /^###\s*help/i.test(l));
  if (helpIndex === -1) return null;

  const elements: FeishuCardElement[] = [];
  const commandLines: string[] = [];

  for (let i = helpIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^###\s*/.test(line)) break;
    if (line.startsWith('/')) commandLines.push(line);
  }

  if (commandLines.length === 0) return null;

  elements.push(larkMd('**Help**'));
  elements.push(
    larkMd(['```text', ...commandLines.map(l => l.replace(/^-\\s*/, '')), '```'].join('\n')),
  );
  return elements;
}

function renderModelsCommand(command: string): FeishuCardElement[] | null {
  const lines = command
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0 || !/^###\s*models/i.test(lines[0])) return null;

  const elements: FeishuCardElement[] = [];
  elements.push(larkMd('**Available Models**'));

  let i = 1;
  const defaults: string[] = [];
  if (lines[i] && /^default:/i.test(lines[i])) {
    i++;
    while (i < lines.length && !/^\S+.*\(.+\)$/.test(lines[i])) {
      defaults.push(lines[i]);
      i++;
    }
  }

  if (defaults.length > 0) {
    elements.push(larkMd(`**Default**\n${defaults.map(d => `- ${d}`).join('\n')}`));
  }

  const providers: Array<{ title: string; models: string }> = [];
  while (i < lines.length) {
    const title = lines[i];
    const modelsLine = lines[i + 1] || '';
    if (/^\S+.*\(.+\)$/.test(title) && /^models:/i.test(modelsLine)) {
      providers.push({ title, models: modelsLine.replace(/^models:\s*/i, '') });
      i += 2;
      continue;
    }
    i++;
  }

  if (providers.length > 0) {
    providers.forEach(p => {
      const models = (p.models || '')
        .split(',')
        .map(m => m.trim())
        .filter(Boolean);
      if (models.length === 0) {
        elements.push(larkMd(`**${p.title}**\n-`));
        return;
      }
      const lines = models.map((m, idx) => `${idx + 1}. ${m}`);
      elements.push(larkMd(`**${p.title}**\n${lines.join('\n')}`));
    });
  }

  return elements.length ? elements : null;
}

export function renderFeishuCardFromHandlerMarkdown(handlerMarkdown: string): string {
  const { command, error, thinking, authorization, answer, tools, files, status } = parseSections(handlerMarkdown);

  const elements: FeishuCardElement[] = [];

  let headerTitle = '🤖 AI Assistant';
  let headerColor = 'blue';

  const hasOnlyStatus =
    !trimSafe(command) &&
    !trimSafe(authorization) &&
    !trimSafe(answer) &&
    !trimSafe(tools) &&
    !trimSafe(thinking);

  if (trimSafe(error)) {
    headerTitle = '🚨 Error';
    headerColor = 'red';
  } else if (hasOnlyStatus && trimSafe(status)) {
    const picked = pickHeaderForStatus(status);
    headerTitle = picked.title;
    headerColor = picked.color;
  } else if (trimSafe(command)) {
    headerTitle = '🧭 Command';
    headerColor = 'green';
  } else if (trimSafe(authorization)) {
    headerTitle = '🔐 Authorization';
    headerColor = 'orange';
  } else if (trimSafe(answer)) {
    headerTitle = '📝 Answer';
    headerColor = 'blue';
  } else if (trimSafe(tools)) {
    headerTitle = '🧰 Tools / Steps';
    headerColor = 'wathet';
  } else if (trimSafe(thinking)) {
    headerTitle = '🤔 Thinking Process';
    headerColor = 'turquoise';
  }

  if (thinking.trim()) {
    const panel = collapsiblePanel('💭 Thinking', thinking, false);
    if (panel) elements.push(panel);
  }

  if (tools.trim()) {
    if (elements.length > 0) elements.push(spacer());
    const panels = splitToolsIntoExecutionPanels(tools);
    panels.forEach((panel, idx) => {
      const rendered = collapsiblePanel(`⚙️ Execution #${idx + 1}`, panel, false, 'turquoise');
      if (rendered) elements.push(rendered);
    });
  }

  if (files.trim()) {
    if (elements.length > 0) elements.push(spacer());
    const panel = collapsiblePanel('🖼️ Files', files, false);
    if (panel) elements.push(panel);
  }

  const finalError = trimSafe(error);
  const finalCommand = trimSafe(command);
  const finalAuthorization = trimSafe(authorization);
  const finalAnswer = trimSafe(answer);

  if (finalError) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: finalError,
      },
    });
  }

  if (finalCommand) {
    const helpElements = renderHelpCommand(finalCommand);
    const modelsElements = helpElements ? null : renderModelsCommand(finalCommand);
    const rendered = helpElements || modelsElements;

    if (rendered) {
      elements.push(...rendered);
    } else {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: finalCommand,
        },
      });
    }
  }

  if (finalAuthorization) {
    if (elements.length > 0) elements.push(hr());
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: finalAuthorization,
      },
    });
  }

  if (finalAnswer) {
    if (elements.length > 0) elements.push(hr());

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: finalAnswer,
      },
    });
  } else if (!status.trim() && !thinking.trim()) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: 'Allocating resources...' },
    });
  }

  if (status.trim()) {
    const { status: cleanStatus, paths } = splitStatusPaths(status.trim());

    if (paths.length > 0) {
      if (cleanStatus) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: cleanStatus },
        });
      }
      elements.push(hr());
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: paths.join('\n') }],
      });
    } else {
      if (elements.length > 0) elements.push(hr());
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: getStatusWithEmoji(cleanStatus) }],
      });
    }
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements: elements.filter(Boolean),
  };

  return JSON.stringify(sanitizeCardValue(card));
}

export class FeishuRenderer {
  render(markdown: string): string {
    return renderFeishuCardFromHandlerMarkdown(markdown);
  }
}
