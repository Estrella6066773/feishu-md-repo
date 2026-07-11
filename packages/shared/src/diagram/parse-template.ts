import type { LegendEntry } from './types.js';

const LEGEND_HEADING_RE = /^##\s*图例\s*$/im;

function splitPrefixes(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-') return [];
  return trimmed
    .split(/\s*\/\s*|\s*、\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function slugType(label: string, index: number): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return ascii || `type_${index + 1}`;
}

/** 从 Markdown 图例表解析 legend 配置 */
export function parseLegendFromMarkdownTable(markdown: string): LegendEntry[] | null {
  const headingMatch = markdown.match(LEGEND_HEADING_RE);
  if (!headingMatch || headingMatch.index == null) return null;

  const afterHeading = markdown.slice(headingMatch.index + headingMatch[0].length);
  const lines = afterHeading.split('\n');

  let tableStart = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? '';
    if (line.startsWith('|') && line.includes('类型')) {
      tableStart = index;
      break;
    }
  }

  if (tableStart < 0) return null;

  const tableLines: string[] = [];
  for (let index = tableStart; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('|')) break;
    tableLines.push(line);
  }

  if (tableLines.length < 3) return null;

  const entries: LegendEntry[] = [];
  for (let rowIndex = 2; rowIndex < tableLines.length; rowIndex++) {
    const cells = tableLines[rowIndex]!
      .split('|')
      .map((cell) => cell.trim())
      .filter((_, cellIndex, array) => cellIndex > 0 && cellIndex < array.length - 1);

    if (cells.length < 5) continue;

    const label = cells[0] ?? '';
    const labelPrefixes = splitPrefixes(cells[1] ?? '');
    const idPrefixes = splitPrefixes(cells[2] ?? '');
    const fill = cells[3] ?? '#ffffff';
    const text = cells[4] ?? '#000000';

    if (!label) continue;

    entries.push({
      type: slugType(label, entries.length),
      label,
      labelPrefixes,
      idPrefixes,
      style: { fill, text },
    });
  }

  return entries.length > 0 ? entries : null;
}
