const DEFAULT_MAX_CHARS = 48_000;
const MAX_MAX_CHARS = 120_000;

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 导出的 Markdown 可能很长，按字符切开，避免一次塞满对话。 */
export function pageText(source: string, offset = 0, maxChars = DEFAULT_MAX_CHARS) {
  const start = Math.max(0, Math.floor(offset));
  const limit = Math.min(Math.max(1, Math.floor(maxChars)), MAX_MAX_CHARS);
  const end = Math.min(source.length, start + limit);
  return {
    text: source.slice(start, end),
    totalChars: source.length,
    offset: start,
    nextOffset: end < source.length ? end : null,
    truncated: end < source.length,
  };
}
