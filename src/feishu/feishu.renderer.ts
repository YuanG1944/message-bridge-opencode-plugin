// src/feishu/feishu.renderer.ts

type FeishuCard = {
  config?: { wide_screen_mode?: boolean };
  header?: { title: { tag: 'plain_text'; content: string }; template?: string };
  elements: any[];
};

function trimSafe(s: string) {
  return (s || '').trim();
}

function larkMd(content: string) {
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: content },
  };
}

function collapsiblePanel(title: string, content: string, expanded = false) {
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
    },
    elements: [larkMd(c)],
  };
}

function getStatusWithEmoji(statusText: string): string {
  const s = statusText.toLowerCase();
  const isDone =
    s.includes('done') || s.includes('stop') || s.includes('finish') || s.includes('idle');

  const emoji = isDone ? '✅' : '⚡️';

  const cleanText = statusText.replace(/\n/g, ' | ').slice(0, 100);
  return `${emoji} ${cleanText}`;
}

function parseSections(md: string) {
  const sectionMap: Record<string, string> = {
    command: '',
    thinking: '',
    answer: '',
    tools: '',
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

    if (rawTitle.includes('think') || rawTitle.includes('思')) {
      sectionMap.thinking += content;
    } else if (rawTitle.includes('command') || rawTitle.includes('命令')) {
      sectionMap.command += content;
    } else if (
      rawTitle.includes('tool') ||
      rawTitle.includes('step') ||
      rawTitle.includes('工具')
    ) {
      sectionMap.tools += content;
    } else if (rawTitle.includes('status') || rawTitle.includes('状态')) {
      sectionMap.status += content;
    } else if (rawTitle.includes('answer') || rawTitle.includes('回答')) {
      sectionMap.answer += content;
    } else {
      sectionMap.answer += `\n\n**${match[2]}**\n${content}`;
    }

    if (!nextMatch) break;
    headerRegex.lastIndex = nextMatch.index;
  }

  if (
    !sectionMap.answer &&
    !sectionMap.command &&
    !sectionMap.thinking &&
    !sectionMap.status
  ) {
    sectionMap.answer = cleanMd;
  }

  return sectionMap;
}

function renderHelpCommand(command: string): any[] | null {
  const lines = command
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const helpIndex = lines.findIndex(l => /^###\s*help/i.test(l));
  if (helpIndex === -1) return null;

  const elements: any[] = [];
  const commandLines: string[] = [];

  for (let i = helpIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^###\s*/.test(line)) break;
    if (line.startsWith('/')) commandLines.push(line);
  }

  if (commandLines.length === 0) return null;

  elements.push(larkMd('**Help**'));
  elements.push(
    larkMd(
      ['```', ...commandLines.map(l => l.replace(/^-\s*/, '')), '```'].join('\n')
    )
  );
  return elements;
}

function renderModelsCommand(command: string): any[] | null {
  const lines = command
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0 || !/^###\s*models/i.test(lines[0])) return null;

  const elements: any[] = [];
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
      elements.push(larkMd(`**${p.title}**\n${p.models || '-'}`));
    });
  }

  return elements.length ? elements : null;
}

export function renderFeishuCardFromHandlerMarkdown(handlerMarkdown: string): string {
  const { command, thinking, answer, tools, status } = parseSections(handlerMarkdown);

  const elements: any[] = [];

  let headerTitle = '🤖 AI Assistant';
  let headerColor = 'blue';

  if (trimSafe(command)) {
    headerTitle = '🧭 Command';
    headerColor = 'green';
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
    elements.push(collapsiblePanel('💭 Thinking', thinking, false));
  }

  if (tools.trim()) {
    if (elements.length > 0) elements.push({ tag: 'div', text: { tag: 'lark_md', content: ' ' } });
    elements.push(collapsiblePanel('⚙️ Execution', tools, false));
  }

  const finalCommand = trimSafe(command);
  const finalAnswer = trimSafe(answer);

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

  if (finalAnswer) {
    if (elements.length > 0) elements.push({ tag: 'hr' });

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
    elements.push({ tag: 'hr' });

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: getStatusWithEmoji(status.trim()) }],
    });
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements: elements.filter(Boolean),
  };

  return JSON.stringify(card);
}

export class FeishuRenderer {
  render(markdown: string): string {
    return renderFeishuCardFromHandlerMarkdown(markdown);
  }
}
