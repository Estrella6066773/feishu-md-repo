import { normalizeTableRows, parseCsv } from '@feishu-md/shared';

export { parseCsv } from '@feishu-md/shared';

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/** 将 CSV 正文转为 GFM 表格 Markdown（仅用于导出等场景，同步请走飞书原生表格） */
export function csvToMarkdown(csvText: string): string {
  const rows = parseCsv(csvText.trim());
  if (rows.length === 0) {
    return '（空表格）';
  }

  const normalized = normalizeTableRows(rows).map((row) => row.map(escapeMarkdownTableCell));
  const header = normalized[0]!;
  const body = normalized.slice(1);
  const separator = header.map(() => '---');

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ];

  return lines.join('\n');
}
