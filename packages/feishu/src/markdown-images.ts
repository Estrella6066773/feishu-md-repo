import { dirname, normalize as pathNormalize, posix } from 'node:path';

export type MarkdownImageSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'image'; alt: string; src: string };

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface MarkdownImageRef {
  alt: string;
  src: string;
}

export function extractMarkdownImageRefs(markdown: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    refs.push({
      alt: match[1] ?? '',
      src: (match[2] ?? '').trim(),
    });
  }
  return refs;
}

/**
 * 将 Markdown 拆成普通正文与图片引用段（含图片时按段插入文档）。
 */
export function splitMarkdownByImages(markdown: string): MarkdownImageSegment[] {
  const segments: MarkdownImageSegment[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const matchIndex = match.index ?? 0;
    const before = markdown.slice(lastIndex, matchIndex);
    if (before) {
      segments.push({ kind: 'markdown', content: before });
    }

    segments.push({
      kind: 'image',
      alt: match[1] ?? '',
      src: (match[2] ?? '').trim(),
    });

    lastIndex = matchIndex + match[0].length;
  }

  const tail = markdown.slice(lastIndex);
  if (tail) {
    segments.push({ kind: 'markdown', content: tail });
  }

  if (segments.length === 0) {
    segments.push({ kind: 'markdown', content: markdown });
  }

  return segments;
}

export function markdownContainsImages(markdown: string): boolean {
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  return MARKDOWN_IMAGE_RE.test(markdown);
}

/** 无法上传图片时，用可读文本替代，避免 convert 生成无效 Image Block */
export function stripMarkdownImagesToFallback(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE_RE, (_full, alt: string, src: string) => {
    const label = alt.trim();
    if (label) return label;
    return `[图片: ${src.trim()}]`;
  });
}

/** 将 Markdown 图片 src 解析为仓库内 Git 路径（相对当前 Markdown 文件） */
export function resolveMarkdownImageGitPath(sourcePath: string, src: string): string {
  const candidates = resolveMarkdownImageGitPathCandidates(sourcePath, src);
  return candidates[0] ?? '';
}

/** 多种策略解析本地图片 Git 路径，便于 Windows / 中文文件名回退 */
export function resolveMarkdownImageGitPathCandidates(sourcePath: string, src: string): string[] {
  const raw = src.trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://')) {
    return [];
  }

  const candidates: string[] = [];
  const push = (path: string) => {
    const normalized = normalizeGitPath(path);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  push(joinMarkdownImagePath(sourcePath, raw));

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) {
      push(joinMarkdownImagePath(sourcePath, decoded));
    }
  } catch {
    // ignore invalid escape
  }

  const fileName = posix.basename(raw);
  if (fileName && fileName !== raw) {
    const sourceDir = posix.dirname(normalizeGitPath(sourcePath));
    push(posix.join(sourceDir === '.' ? '' : sourceDir, fileName));
  }

  return candidates;
}

/** 从 Git 读取 Markdown 引用的本地图片二进制 */
export async function readGitImageBinary(
  readBinaryFile: (path: string) => Promise<Uint8Array | null>,
  sourcePath: string,
  src: string,
): Promise<{ data: Uint8Array; gitPath: string } | null> {
  for (const gitPath of resolveMarkdownImageGitPathCandidates(sourcePath, src)) {
    const data = await readBinaryFile(gitPath);
    if (data && data.byteLength > 0) {
      return { data, gitPath };
    }
  }
  return null;
}

function joinMarkdownImagePath(sourcePath: string, src: string): string {
  const normalizedSource = normalizeGitPath(sourcePath);
  const baseDir = posix.dirname(normalizedSource) === '.' ? '' : posix.dirname(normalizedSource);
  return normalizeGitPath(pathNormalize(posix.normalize(posix.join(baseDir, src))));
}

/** Markdown 正文是否引用了 changedPaths 中的本地图片 */
export function markdownReferencesChangedImages(
  markdown: string,
  sourcePath: string,
  changedPaths: Set<string>,
): boolean {
  for (const ref of extractMarkdownImageRefs(markdown)) {
    const gitPath = resolveMarkdownImageGitPath(sourcePath, ref.src);
    if (gitPath && changedPaths.has(gitPath)) {
      return true;
    }
  }
  return false;
}

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
