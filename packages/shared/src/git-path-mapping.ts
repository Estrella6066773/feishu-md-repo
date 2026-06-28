import type { NodeMapping } from './types.js';
import { normalizeRepoPath } from './path-globs.js';

function pathDirname(path: string): string {
  const normalized = normalizeRepoPath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function pathExtname(path: string): string {
  const normalized = normalizeRepoPath(path);
  const index = normalized.lastIndexOf('.');
  if (index <= normalized.lastIndexOf('/')) return '';
  return normalized.slice(index);
}

/** 将 Git 路径解析为已同步的飞书节点映射（含 README → 目录等规则） */
export function findNodeMappingForGitPath(
  gitPath: string,
  mappingByGitPath: Map<string, NodeMapping>,
): NodeMapping | undefined {
  const resolvedPath = normalizeRepoPath(gitPath);
  const candidates = new Set<string>([resolvedPath.replace(/\/+$/, ''), resolvedPath]);

  if (!pathExtname(resolvedPath)) {
    candidates.add(`${resolvedPath}.md`);
    candidates.add(`${resolvedPath}/README.md`);
    candidates.add(`${resolvedPath}/readme.md`);
    candidates.add(`${resolvedPath}/Readme.md`);
  }

  for (const candidate of [...candidates]) {
    if (candidate.toLowerCase().endsWith('/readme.md')) {
      const dir = pathDirname(candidate);
      candidates.add(dir === '.' ? '' : dir);
    }
  }

  for (const candidate of candidates) {
    const mapping = mappingByGitPath.get(normalizeRepoPath(candidate));
    if (mapping) return mapping;
  }

  return undefined;
}
