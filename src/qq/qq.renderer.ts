// src/qq/qq.renderer.ts
import { sanitizeTemplateMarkers } from '../utils';

export type RenderedFile = {
  filename?: string;
  mime?: string;
  url: string;
};

function trimSafe(s: string) {
  return (s || '').trim();
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

    const sectionKey = matchSectionKey(rawTitle);
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

// 移除markdown格式标记
function removeMarkdownFormatting(text: string): string {
  if (!text) return '';
  return text
    // 移除粗体标记 **text**
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // 移除斜体标记 *text* 或 _text_
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    // 移除代码块标记 `code`
    .replace(/`([^`]*)`/g, '$1')
    // 移除标题标记 # ## ###
    .replace(/^#{1,6}\s+/gm, '')
    // 移除链接格式 [text](url) -> text
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    // 移除图片格式 ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '$1')
    // 移除水平线
    .replace(/^---+$/gm, '')
    // 清理多余的空行（保留单个空行）
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderQQMessageFromHandlerMarkdown(handlerMarkdown: string): string {
  const { command, error, thinking, authorization, answer, tools, files } = parseSections(handlerMarkdown);

  // 优先显示 answer，如果没有则显示其他内容
  // 去掉所有markdown格式，只保留纯文本
  const parts: string[] = [];

  // 优先显示 answer
  if (trimSafe(answer)) {
    const cleanAnswer = removeMarkdownFormatting(sanitizeTemplateMarkers(answer));
    if (cleanAnswer) {
      parts.push(cleanAnswer);
    }
  }

  // 如果有错误，显示错误信息
  if (trimSafe(error)) {
    const cleanError = removeMarkdownFormatting(sanitizeTemplateMarkers(error));
    if (cleanError) {
      parts.push(cleanError);
    }
  }

  // 如果没有 answer，显示其他有用信息（但不包括 status）
  if (!trimSafe(answer)) {
    if (trimSafe(authorization)) {
      const cleanAuthorization = removeMarkdownFormatting(sanitizeTemplateMarkers(authorization));
      if (cleanAuthorization) {
        parts.push(cleanAuthorization);
      }
    }

    if (trimSafe(thinking)) {
      const cleanThinking = removeMarkdownFormatting(sanitizeTemplateMarkers(thinking));
      if (cleanThinking) {
        parts.push(cleanThinking);
      }
    }

    if (trimSafe(tools)) {
      const cleanTools = removeMarkdownFormatting(sanitizeTemplateMarkers(tools));
      if (cleanTools) {
        parts.push(cleanTools);
      }
    }

    if (trimSafe(command)) {
      const cleanCommand = removeMarkdownFormatting(sanitizeTemplateMarkers(command));
      if (cleanCommand) {
        parts.push(cleanCommand);
      }
    }
  }

  // 文件信息不显示在消息中（文件会单独发送）

  if (parts.length === 0) {
    return 'Allocating resources...';
  }

  // 用单个换行符连接，不使用分隔符
  return parts.join('\n\n');
}

export class QQRenderer {
  render(markdown: string): string {
    return renderQQMessageFromHandlerMarkdown(markdown);
  }
}
