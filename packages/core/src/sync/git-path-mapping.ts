import { basename, dirname } from 'node:path';
import type { FeishuTargetType, NodeMapping, SyncMode } from '@feishu-md/shared';
import { toFeishuDocumentUrl } from '@feishu-md/feishu';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isReadmeBasename(name: string, readmeNames: string[]): boolean {
  const lower = name.toLowerCase();
  return readmeNames.some((candidate) => candidate.toLowerCase() === lower);
}

/** 将 Git 变更路径映射为 node_mapping 查找键（仓库模式下 README 对应目录逻辑路径） */
export function gitPathToMappingCandidates(
  gitPath: string,
  syncMode: SyncMode,
  readmeNames: string[],
): string[] {
  const normalized = normalizePath(gitPath);
  const candidates = new Set<string>([normalized]);

  if (syncMode === 'workspace') {
    return [...candidates];
  }

  const base = basename(normalized);
  if (isReadmeBasename(base, readmeNames)) {
    const dir = dirname(normalized);
    const logical = dir === '.' ? '' : dir;
    candidates.add(logical);
  } else if (isMarkdownFile(normalized)) {
    candidates.add(normalized);
  } else {
    const dir = dirname(normalized);
    const logical = dir === '.' ? '' : dir;
    candidates.add(logical);
  }

  return [...candidates];
}

export function resolveGitPathToDocumentUrl(
  gitPath: string,
  mappingByGitPath: Map<string, NodeMapping>,
  syncMode: SyncMode,
  readmeNames: string[],
): string | undefined {
  for (const candidate of gitPathToMappingCandidates(gitPath, syncMode, readmeNames)) {
    const mapping = mappingByGitPath.get(normalizePath(candidate));
    if (!mapping || mapping.feishuNodeType === 'folder') continue;
    return toFeishuDocumentUrl({
      feishuTargetType: mapping.feishuTargetType as FeishuTargetType,
      feishuNodeToken: mapping.feishuNodeToken,
      feishuDocToken: mapping.feishuDocToken,
      feishuNodeType: mapping.feishuNodeType,
    });
  }
  return undefined;
}
