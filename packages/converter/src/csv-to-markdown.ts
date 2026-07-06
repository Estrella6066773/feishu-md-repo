function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析 RFC 4180 风格 CSV（逗号分隔、双引号转义） */
export function parseCsv(text: string): string[][] {
  const content = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\r' && content[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0 || inQuotes) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells, rowIndex) => {
    if (rowIndex < rows.length - 1) return true;
    return cells.some((cell) => cell.trim() !== '');
  });
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/** 将 CSV 正文转为 GFM 表格 Markdown（飞书写入时会再展平为列表） */
export function csvToMarkdown(csvText: string): string {
  const rows = parseCsv(csvText.trim());
  if (rows.length === 0) {
    return '（空表格）';
  }

  const normalized = rows.map((row) => row.map(escapeMarkdownTableCell));
  const columnCount = Math.max(...normalized.map((row) => row.length), 1);
  const padded = normalized.map((row) => {
    const copy = [...row];
    while (copy.length < columnCount) {
      copy.push('');
    }
    return copy;
  });

  const header = padded[0]!;
  const body = padded.slice(1);
  const separator = header.map(() => '---');

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ];

  return lines.join('\n');
}
