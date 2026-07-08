import { normalizeTableRows } from '@feishu-md/shared';

export type MarkdownTableSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'table'; rows: string[][] };

function isGfmTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parseGfmTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return [];
  }
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** 将 Markdown 按 GFM 表格切分为文本段与表格段 */
export function splitMarkdownByTables(markdown: string): MarkdownTableSegment[] {
  const lines = markdown.split('\n');
  const segments: MarkdownTableSegment[] = [];
  const markdownBuffer: string[] = [];
  let index = 0;

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) {
      return;
    }
    segments.push({ kind: 'markdown', content: markdownBuffer.join('\n') });
    markdownBuffer.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (
      line.trim().startsWith('|')
      && index + 1 < lines.length
      && isGfmTableSeparator(lines[index + 1]!)
    ) {
      flushMarkdown();

      const tableLines = [line, lines[index + 1]!];
      index += 2;
      while (index < lines.length && lines[index]!.trim().startsWith('|')) {
        tableLines.push(lines[index]!);
        index += 1;
      }

      const rows = normalizeTableRows(
        tableLines
          .filter((tableLine) => !isGfmTableSeparator(tableLine))
          .map(parseGfmTableRow)
          .filter((cells) => cells.length > 0),
      );

      if (rows.length > 0) {
        segments.push({ kind: 'table', rows });
      }
      continue;
    }

    markdownBuffer.push(line);
    index += 1;
  }

  flushMarkdown();

  if (segments.length === 0) {
    return [{ kind: 'markdown', content: markdown }];
  }

  return segments;
}

export function markdownContainsGfmTable(markdown: string): boolean {
  return splitMarkdownByTables(markdown).some((segment) => segment.kind === 'table');
}
