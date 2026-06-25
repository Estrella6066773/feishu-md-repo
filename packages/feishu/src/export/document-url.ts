export type FeishuDocumentUrlSource = 'docx' | 'wiki';

export interface ParsedDocumentUrl {
  token: string;
  source: FeishuDocumentUrlSource;
}

/** 从飞书 docx / wiki 链接中提取 token 与来源类型 */
export function parseFeishuDocumentUrl(url: string): ParsedDocumentUrl | null {
  const trimmed = url.trim();

  const docxMatch = /\/docx\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (docxMatch?.[1]) {
    return { token: docxMatch[1], source: 'docx' };
  }

  const wikiMatch = /\/wiki\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (wikiMatch?.[1]) {
    return { token: wikiMatch[1], source: 'wiki' };
  }

  return null;
}
