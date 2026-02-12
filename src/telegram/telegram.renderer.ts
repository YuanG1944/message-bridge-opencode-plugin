// src/telegram/telegram.renderer.ts
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function restoreCodeBlocks(text: string, codeBlocks: string[]): string {
  return text.replace(/@@CODEBLOCK_(\d+)@@/g, (_, idxRaw: string) => {
    const idx = Number(idxRaw);
    return codeBlocks[idx] || '';
  });
}

function trimSafe(s: string): string {
  return (s || '').trim();
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

function parseSections(md: string): Record<string, string> {
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

  const cleanMd = (md || '').replace(/\r\n/g, '\n');
  const headerRegex = /(?:^|\n)(##+|(?:\*\*))\s*(.*?)(?:(?:\*\*|:)?)(?=\n|$)/g;
  let match: RegExpExecArray | null;

  const firstMatch = headerRegex.exec(cleanMd);
  if (firstMatch && firstMatch.index > 0) {
    sectionMap.answer = cleanMd.slice(0, firstMatch.index);
  }
  headerRegex.lastIndex = 0;

  while ((match = headerRegex.exec(cleanMd)) !== null) {
    const startIndex = match.index + match[0].length;
    const nextMatch = headerRegex.exec(cleanMd);
    const endIndex = nextMatch ? nextMatch.index : cleanMd.length;
    headerRegex.lastIndex = endIndex;

    const content = cleanMd.slice(startIndex, endIndex);
    const sectionKey = matchSectionKey(match[2]);
    if (sectionKey) sectionMap[sectionKey] += content;
    else sectionMap.answer += `\n\n**${match[2]}**\n${content}`;

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
  if (toolStartIndexes.length === 0) return raw ? [raw] : [];

  const panels: string[] = [];
  for (let i = 0; i < toolStartIndexes.length; i++) {
    const start = toolStartIndexes[i];
    const end = i + 1 < toolStartIndexes.length ? toolStartIndexes[i + 1] : lines.length;
    const block = trimSafe(lines.slice(start, end).join('\n'));
    if (block) panels.push(block);
  }
  return panels;
}

function buildTelegramMarkdown(markdown: string): string {
  const sections = parseSections(markdown);
  const out: string[] = [];

  const pushSection = (title: string, content: string) => {
    const c = trimSafe(content);
    if (!c) return;
    out.push(`## ${title}`);
    out.push(c);
    out.push('');
  };

  pushSection('Command', sections.command);
  pushSection('Authorization', sections.authorization);
  if (trimSafe(sections.thinking)) {
    out.push('## Thinking');
    out.push('💭 Thinking (collapsed)');
    out.push('');
  }

  const tools = trimSafe(sections.tools);
  if (tools) {
    out.push('## Tools / Steps');
    const panels = splitToolsIntoExecutionPanels(tools);
    if (panels.length === 0) out.push('⚙️ Execution #1');
    else panels.forEach((_, idx) => out.push(`⚙️ Execution #${idx + 1}`));
    out.push('');
  }

  pushSection('Files', sections.files);
  pushSection('Error', sections.error);
  pushSection('Answer', sections.answer);

  const status = trimSafe(sections.status);
  if (status) {
    const compact = status
      .split('\n')
      .map(s => trimSafe(s))
      .filter(Boolean)
      .join(' · ');
    out.push(`@@STATUS_INLINE@@${compact}`);
    out.push('');
  }

  return out.join('\n').trim();
}

export function renderTelegram(markdown: string): string {
  let text = buildTelegramMarkdown(markdown).trim();
  if (!text) return '';

  const codeBlocks: string[] = [];
  text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_, code: string) => {
    const html = `<pre><code>${escapeHtml((code || '').trim())}</code></pre>`;
    const id = codeBlocks.push(html) - 1;
    return `@@CODEBLOCK_${id}@@`;
  });

  text = escapeHtml(text);
  text = text.replace(/^##\s+Command$/gm, '<b>🧭 Command</b>\n');
  text = text.replace(/^##\s+Authorization$/gm, '<b>🔐 Authorization</b>\n');
  text = text.replace(/^##\s+Thinking$/gm, '<b>🤔 Thinking</b>\n');
  text = text.replace(/^##\s+Tools(?:\s*\/\s*Steps)?$/gim, '<b>🧰 Tools / Steps</b>\n');
  text = text.replace(/^##\s+Files$/gm, '<b>🖼️ Files</b>\n');
  text = text.replace(/^##\s+Answer$/gm, '<b>📝 Answer</b>\n');
  text = text.replace(/^##\s+Error$/gm, '<b>🚨 Error</b>\n');
  text = text.replace(/^###\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/^##\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/^#\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/^\s*-\s+(.+)$/gm, '• $1');
  text = text.replace(/^\s*>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/^@@STATUS_INLINE@@(.+)$/gm, '<b>✅</b> <code>$1</code>');

  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  text = restoreCodeBlocks(text, codeBlocks);
  return text;
}
