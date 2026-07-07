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

export function normalizeTableRows(rows: string[][]): string[][] {
  if (rows.length === 0) return [];
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return rows.map((row) => {
    const copy = row.map((cell) => cell.replace(/\n/g, ' ').trim());
    while (copy.length < columnCount) {
      copy.push('');
    }
    return copy;
  });
}
