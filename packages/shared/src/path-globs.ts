/**
 * 项目级二重屏蔽：绑定配置的 ignoreGlobs（gitignore 风格）
 */
export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let pattern = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        pattern += '.*';
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  pattern += '$';
  return new RegExp(pattern);
}

export function matchesProjectPathGlob(path: string, glob: string): boolean {
  const normalized = normalizeRepoPath(path);
  const g = glob.replace(/\\/g, '/');

  if (g.includes('/')) {
    return globToRegExp(g).test(normalized);
  }

  const segments = normalized.split('/');
  return segments.some((segment) => globToRegExp(g).test(segment)) || globToRegExp(`**/${g}`).test(normalized);
}

export function matchesProjectIgnoreGlob(path: string, glob: string): boolean {
  return matchesProjectPathGlob(path, glob);
}

export function matchesAnyProjectPathGlob(path: string, globs: string[] | undefined): boolean {
  return (globs ?? []).some((glob) => glob.trim() && matchesProjectPathGlob(path, glob.trim()));
}

export function filterPathsByProjectIgnoreGlobs(paths: string[], ignoreGlobs: string[]): string[] {
  if (ignoreGlobs.length === 0) return paths;
  return paths.filter((path) => !matchesAnyProjectPathGlob(path, ignoreGlobs));
}

export const DEFAULT_PROJECT_IGNORE_GLOBS = ['**/node_modules/**', '**/.git/**'] as const;

export function mergeProjectIgnoreGlobs(custom: string[] | undefined): string[] {
  const merged = [...DEFAULT_PROJECT_IGNORE_GLOBS, ...(custom ?? [])];
  return [...new Set(merged.map((item) => item.trim()).filter(Boolean))];
}

/** 将多行文本解析为 glob 列表（绑定表单等场景） */
export function parseGlobsFromMultilineText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
