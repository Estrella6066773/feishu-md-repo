import { dirname, normalize as pathNormalize, posix } from 'node:path';

export type MarkdownImageSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'image'; alt: string; src: string };

/**
 * 统一图片引用正则：同时匹配两种格式
 * - Markdown: ![alt](src)
 * - HTML:    <img src="..." alt="..." />
 *
 * img 标签的 src/alt 不在此正则中提取（属性顺序不确定），
 * 而是从 match[0]（完整标签字符串）中单独用属性正则提取。
 */
const IMAGE_RE = /<img\s[^>]*\/?[>]|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi;

/** 从 <img> 标签字符串中提取属性 */
const IMG_SRC_RE = /\bsrc\s*=\s*"([^"]+)"/i;
const IMG_ALT_RE = /\balt\s*=\s*"([^"]*)"/i;

export interface MarkdownImageRef {
  alt: string;
  src: string;
}

/**
 * 屏蔽代码块与行内代码，避免其中的图片语法被当作真实引用。
 * 长度不变，便于用 match.index 回指原文。
 */
function maskNonImageMarkdownRegions(markdown: string): string {
  let masked = markdown;
  masked = masked.replace(/```[\s\S]*?```/g, (match) => ' '.repeat(match.length));
  masked = masked.replace(/`[^`\n]+`/g, (match) => ' '.repeat(match.length));
  return masked;
}

function parseImgTagSrc(full: string): string {
  return (full.match(IMG_SRC_RE)?.[1] ?? '').trim();
}

function parseImgTagAlt(full: string): string {
  return (full.match(IMG_ALT_RE)?.[1] ?? '').trim();
}

function matchSrc(m: RegExpMatchArray): string {
  const full = m[0];
  if (full.startsWith('<img')) return parseImgTagSrc(full);
  return (m[2] ?? '').trim();
}

function matchAlt(m: RegExpMatchArray): string {
  const full = m[0];
  if (full.startsWith('<img')) return parseImgTagAlt(full);
  return (m[1] ?? '').trim();
}

export function extractMarkdownImageRefs(markdown: string): MarkdownImageRef[] {
  const masked = maskNonImageMarkdownRegions(markdown);
  const refs: MarkdownImageRef[] = [];
  IMAGE_RE.lastIndex = 0;
  for (const match of masked.matchAll(IMAGE_RE)) {
    refs.push({
      alt: matchAlt(match),
      src: matchSrc(match),
    });
  }
  return refs;
}

/**
 * 将 Markdown 拆成普通正文与图片引用段（含图片时按段插入文档）。
 * 同时支持 ![alt](src) 和 <img src="..." alt="..." /> 两种格式。
 */
export function splitMarkdownByImages(markdown: string): MarkdownImageSegment[] {
  const masked = maskNonImageMarkdownRegions(markdown);
  const segments: MarkdownImageSegment[] = [];
  let lastIndex = 0;

  IMAGE_RE.lastIndex = 0;
  for (const match of masked.matchAll(IMAGE_RE)) {
    const matchIndex = match.index ?? 0;
    const before = markdown.slice(lastIndex, matchIndex);
    if (before) {
      segments.push({ kind: 'markdown', content: before });
    }

    segments.push({
      kind: 'image',
      alt: matchAlt(match),
      src: matchSrc(match),
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
  const masked = maskNonImageMarkdownRegions(markdown);
  IMAGE_RE.lastIndex = 0;
  return IMAGE_RE.test(masked);
}

/** 无法上传图片时，用可读文本替代，避免 convert 生成无效 Image Block */
export function stripMarkdownImagesToFallback(markdown: string): string {
  return markdown.replace(IMAGE_RE, (full, mdAlt, mdSrc) => {
    let src: string;
    let alt: string;
    if (full.startsWith('<img')) {
      src = parseImgTagSrc(full);
      alt = parseImgTagAlt(full);
    } else {
      src = mdSrc ?? '';
      alt = mdAlt ?? '';
    }
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
