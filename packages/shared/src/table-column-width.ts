/** 飞书表格列宽下限（px） */
export const TABLE_COLUMN_MIN_WIDTH = 50;
/** 飞书表格列宽上限（px） */
export const TABLE_COLUMN_MAX_WIDTH = 1300;
/** 飞书文档正文区参考宽度，用于宽表总宽归一化 */
export const TABLE_DEFAULT_VIEWPORT_WIDTH = 900;

export type TableColumnType = 'boolean' | 'numeric' | 'date' | 'url' | 'id' | 'text';

export type TableColumnWidthStrategy = 'auto' | 'equal' | 'content';

export interface TableColumnWidthOptions {
  /** 是否启用智能列宽，默认 true */
  enabled?: boolean;
  /** 表格总宽目标（px） */
  viewportWidth?: number;
  /** 单列最大计算宽度（px），超出部分依赖单元格内换行 */
  maxColumnWidth?: number;
  /** 首行是否为表头 */
  headerRow?: boolean;
  strategy?: TableColumnWidthStrategy;
}

const CELL_PADDING_PX = 32;
const ASCII_CHAR_PX = 8;
const CJK_CHAR_PX = 14;
/** 参与宽度估算的单格字符上限，避免个别超长单元格独占列宽 */
const CELL_CHAR_SOFT_CAP = 48;

const BOOLEAN_PATTERN = /^(true|false|yes|no|y|n|是|否|对|错|✓|✗|√|×|ok|done|pending|running|success|failed)$/i;
const NUMERIC_PATTERN = /^-?\d+([.,]\d+)?%?$/;
const DATE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;
const URL_PATTERN = /^https?:\/\//i;
const ID_PATTERN = /^[0-9a-f]{7,40}$/i;

function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
  );
}

/** 去除行内 Markdown 标记，按可见文字估算宽度 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function effectiveCharCount(text: string): number {
  const plain = stripInlineMarkdown(text);
  let count = 0;
  for (const char of plain) {
    count += isCjkChar(char) ? 1.4 : 1;
  }
  return count;
}

/**
 * 文字越多列越宽，但增速递减，避免单列过宽。
 * 短文本约 80–120px，中等文本约 150–220px，长文本约 250–380px。
 */
export function contentLengthToWidth(charCount: number): number {
  if (charCount <= 0) {
    return CELL_PADDING_PX;
  }

  const capped = Math.min(charCount, CELL_CHAR_SOFT_CAP);
  let width = CELL_PADDING_PX;

  if (capped <= 12) {
    width += capped * 7;
  } else if (capped <= 28) {
    width += 12 * 7 + (capped - 12) * 9;
  } else {
    width += 12 * 7 + 16 * 9 + (capped - 28) * 6;
  }

  // 平均文字量较多时，额外适度加宽，提升可读性
  if (charCount > 16) {
    width += Math.min((charCount - 16) * 1.8, 72);
  }

  return Math.round(width);
}

function measureCellWidth(text: string): number {
  return contentLengthToWidth(effectiveCharCount(text));
}

function isBooleanLike(text: string): boolean {
  const value = stripInlineMarkdown(text);
  return value.length > 0 && value.length <= 12 && BOOLEAN_PATTERN.test(value);
}

function isNumericLike(text: string): boolean {
  const value = stripInlineMarkdown(text).replace(/,/g, '');
  return value.length > 0 && NUMERIC_PATTERN.test(value);
}

function isDateLike(text: string): boolean {
  const value = stripInlineMarkdown(text);
  return value.length > 0 && DATE_PATTERN.test(value);
}

function isUrlLike(text: string): boolean {
  const value = stripInlineMarkdown(text);
  return URL_PATTERN.test(value) || (value.includes('/') && value.length > 24);
}

function isIdLike(text: string): boolean {
  const value = stripInlineMarkdown(text);
  return value.length >= 7 && value.length <= 40 && ID_PATTERN.test(value);
}

export function inferColumnType(cells: string[]): TableColumnType {
  const nonEmpty = cells.map(stripInlineMarkdown).filter((cell) => cell.length > 0);
  if (nonEmpty.length === 0) {
    return 'text';
  }
  if (nonEmpty.every(isBooleanLike)) return 'boolean';
  if (nonEmpty.every(isNumericLike)) return 'numeric';
  if (nonEmpty.every(isDateLike)) return 'date';
  if (nonEmpty.every(isUrlLike)) return 'url';
  if (nonEmpty.every(isIdLike)) return 'id';
  return 'text';
}

const COLUMN_TYPE_WIDTH_FACTOR: Record<TableColumnType, number> = {
  boolean: 0.72,
  numeric: 0.85,
  date: 1.0,
  id: 1.05,
  url: 1.35,
  text: 1.0,
};

const COLUMN_TYPE_MIN_WIDTH: Partial<Record<TableColumnType, number>> = {
  boolean: 64,
  numeric: 72,
  date: 118,
  id: 96,
};

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

function computeColumnContentWidth(cells: string[], columnType: TableColumnType): number {
  const measured = cells
    .map(measureCellWidth)
    .filter((width) => width > CELL_PADDING_PX);

  if (measured.length === 0) {
    return 100;
  }

  const sorted = [...measured].sort((left, right) => left - right);
  const max = sorted[sorted.length - 1]!;
  const avg = measured.reduce((sum, width) => sum + width, 0) / measured.length;
  const p75 = sorted[Math.floor((sorted.length - 1) * 0.75)] ?? max;

  // 偏向较高分位与均值，使文字较多的列适度加宽，同时抑制极端值
  const blended = max * 0.28 + p75 * 0.42 + avg * 0.30;
  const typed = blended * COLUMN_TYPE_WIDTH_FACTOR[columnType];
  const typeMin = COLUMN_TYPE_MIN_WIDTH[columnType] ?? TABLE_COLUMN_MIN_WIDTH;

  return clampWidth(typed, typeMin, TABLE_COLUMN_MAX_WIDTH);
}

function normalizeWidthsToViewport(
  widths: number[],
  viewportWidth: number,
  columnTypes: TableColumnType[],
): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= viewportWidth) {
    return widths;
  }

  const scale = viewportWidth / total;
  const scaled = widths.map((width, index) => {
    const typeMin = COLUMN_TYPE_MIN_WIDTH[columnTypes[index]!] ?? TABLE_COLUMN_MIN_WIDTH;
    return Math.max(typeMin, Math.round(width * scale));
  });

  const scaledTotal = scaled.reduce((sum, width) => sum + width, 0);
  if (scaledTotal <= viewportWidth) {
    return scaled;
  }

  // 缩放后仍超出时，对文本列优先压缩
  let overflow = scaledTotal - viewportWidth;
  const indices = scaled
    .map((width, index) => ({ width, index, type: columnTypes[index]! }))
    .filter((item) => item.type === 'text' || item.type === 'url')
    .sort((left, right) => right.width - left.width);

  const result = [...scaled];
  for (const item of indices) {
    if (overflow <= 0) break;
    const typeMin = COLUMN_TYPE_MIN_WIDTH[item.type] ?? TABLE_COLUMN_MIN_WIDTH;
    const reducible = result[item.index]! - typeMin;
    if (reducible <= 0) continue;
    const reduction = Math.min(reducible, overflow);
    result[item.index] = result[item.index]! - reduction;
    overflow -= reduction;
  }

  return result;
}

function distributeRemainingViewport(
  widths: number[],
  viewportWidth: number,
  columnTypes: TableColumnType[],
): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const slack = viewportWidth - total;
  if (slack < 40) {
    return widths;
  }

  const textIndices = columnTypes
    .map((type, index) => ({ type, index }))
    .filter((item) => item.type === 'text' || item.type === 'url')
    .map((item) => item.index);

  if (textIndices.length === 0) {
    return widths;
  }

  const result = [...widths];
  const perColumn = Math.floor(slack / textIndices.length);
  for (const index of textIndices) {
    result[index] = clampWidth(
      result[index]! + perColumn,
      TABLE_COLUMN_MIN_WIDTH,
      TABLE_COLUMN_MAX_WIDTH,
    );
  }
  return result;
}

/**
 * 根据表格内容计算各列宽度（px）。
 * 文字较多的列会适度加宽；宽表会按视口宽度归一化。
 */
export function computeTableColumnWidths(
  rows: string[][],
  options: TableColumnWidthOptions = {},
): number[] {
  if (rows.length === 0 || rows[0]!.length === 0) {
    return [];
  }

  const {
    enabled = true,
    viewportWidth = TABLE_DEFAULT_VIEWPORT_WIDTH,
    maxColumnWidth = 400,
    headerRow = rows.length > 1,
    strategy = 'auto',
  } = options;

  const columnCount = rows[0]!.length;
  if (!enabled) {
    return Array.from({ length: columnCount }, () => 100);
  }

  if (strategy === 'equal') {
    const equalWidth = clampWidth(
      Math.floor(viewportWidth / columnCount),
      TABLE_COLUMN_MIN_WIDTH,
      TABLE_COLUMN_MAX_WIDTH,
    );
    return Array.from({ length: columnCount }, () => equalWidth);
  }

  const dataRows = headerRow ? rows.slice(1) : rows;
  const headerRowCells = headerRow ? rows[0]! : [];

  const columnTypes: TableColumnType[] = [];
  const rawWidths: number[] = [];

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const columnCells = dataRows.map((row) => row[columnIndex] ?? '');
    const headerCell = headerRow ? headerRowCells[columnIndex] ?? '' : '';
    const allCells = headerCell ? [headerCell, ...columnCells] : columnCells;

    const columnType = inferColumnType(allCells);
    columnTypes.push(columnType);

    let width = computeColumnContentWidth(columnCells.length > 0 ? columnCells : allCells, columnType);

    if (headerCell) {
      const headerWidth = measureCellWidth(headerCell);
      width = Math.max(width, Math.round(headerWidth * 1.08));
    }

    rawWidths.push(clampWidth(width, TABLE_COLUMN_MIN_WIDTH, maxColumnWidth));
  }

  let widths = strategy === 'content'
    ? rawWidths
    : normalizeWidthsToViewport(rawWidths, viewportWidth, columnTypes);

  widths = distributeRemainingViewport(widths, viewportWidth, columnTypes);

  return widths.map((width) =>
    clampWidth(width, TABLE_COLUMN_MIN_WIDTH, TABLE_COLUMN_MAX_WIDTH),
  );
}
