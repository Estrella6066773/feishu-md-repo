import { basename, dirname } from 'node:path';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

export interface RepositoryContainer {
  /** 逻辑目录路径（与 node_mapping.git_path 一致，根目录为空字符串） */
  logicalPath: string;
  /** 该目录下的 README 路径 */
  sourcePath: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function logicalPathDepth(logicalPath: string): number {
  if (!logicalPath) return 0;
  return logicalPath.split('/').length;
}

function collectDirectoryPrefixes(paths: string[]): Set<string> {
  const directories = new Set<string>(['']);
  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    let current = dirname(path);
    while (true) {
      directories.add(current === '.' ? '' : current);
      if (current === '.' || current === '') break;
      current = dirname(current);
    }
  }
  return directories;
}

function findReadmeSource(
  logicalPath: string,
  treeSet: Set<string>,
  readmeNames: string[],
): string | null {
  const candidates = logicalPath
    ? readmeNames.map((name) => `${logicalPath}/${name}`)
    : readmeNames;

  return candidates.find((path) => treeSet.has(path)) ?? null;
}

export function resolveRepositoryContainer(
  logicalPath: string,
  treeSet: Set<string>,
  readmeNames: string[],
): RepositoryContainer | null {
  const readmeSource = findReadmeSource(logicalPath, treeSet, readmeNames);
  if (!readmeSource) return null;
  return { logicalPath, sourcePath: readmeSource };
}

export function resolveRepositoryParentLogicalPath(
  logicalPath: string,
  containerPaths: Set<string>,
): string | undefined {
  if (!logicalPath) return undefined;

  let current = dirname(logicalPath);
  while (true) {
    const candidate = current === '.' ? '' : current;
    if (containerPaths.has(candidate)) return candidate;
    if (current === '.' || current === '') break;
    current = dirname(current);
  }

  return undefined;
}

export function discoverRepositoryContainers(
  treePaths: string[],
  readmeNames: string[],
): RepositoryContainer[] {
  const treeSet = new Set(treePaths.map(normalizePath));
  const logicalPaths = collectDirectoryPrefixes(treePaths);
  const containers: RepositoryContainer[] = [];
  const seen = new Set<string>();

  for (const logicalPath of logicalPaths) {
    const container = resolveRepositoryContainer(logicalPath, treeSet, readmeNames);
    if (!container || seen.has(container.logicalPath)) continue;
    seen.add(container.logicalPath);
    containers.push(container);
  }

  return containers.sort(
    (a, b) => logicalPathDepth(a.logicalPath) - logicalPathDepth(b.logicalPath),
  );
}

export function isRepositoryContainerDirty(
  container: RepositoryContainer,
  changedPaths: Set<string>,
  incremental: boolean,
): boolean {
  if (!incremental) return true;
  if (changedPaths.has(container.sourcePath)) return true;

  const prefix = container.logicalPath ? `${container.logicalPath}/` : '';
  for (const path of changedPaths) {
    if (!container.logicalPath || path.startsWith(prefix)) return true;
  }

  return false;
}

/** 飞书文档标题：根目录用绑定名称，子目录用目录名 */
export function repositoryContainerTitle(logicalPath: string, bindingName: string): string {
  return logicalPath ? basename(logicalPath) : bindingName;
}

function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isReadmeBasename(name: string, readmeNames: string[]): boolean {
  const lower = name.toLowerCase();
  return readmeNames.some((candidate) => candidate.toLowerCase() === lower);
}

/** 独立 Markdown 文件（非目录 README 正文） */
export function discoverStandaloneMarkdownFiles(
  treePaths: string[],
  readmeNames: string[],
  containerSourcePaths: Set<string>,
): string[] {
  return treePaths
    .map(normalizePath)
    .filter((path) => isMarkdownFile(path))
    .filter((path) => !containerSourcePaths.has(path))
    .filter((path) => !isReadmeBasename(basename(path), readmeNames))
    .sort((a, b) => a.localeCompare(b));
}

export function standaloneMarkdownTitle(filePath: string): string {
  const base = basename(filePath);
  for (const ext of MARKDOWN_EXTENSIONS) {
    if (base.toLowerCase().endsWith(ext)) {
      return base.slice(0, -ext.length);
    }
  }
  return base;
}

/** 独立文档的父容器：优先所在目录，否则向上找最近含 README 的目录 */
export function resolveParentForStandaloneFile(
  filePath: string,
  containerPaths: Set<string>,
): string | undefined {
  const dir = dirname(normalizePath(filePath));
  const logicalDir = dir === '.' ? '' : dir;

  if (containerPaths.has(logicalDir)) {
    return logicalDir;
  }

  return resolveRepositoryParentLogicalPath(logicalDir, containerPaths);
}

export function isStandaloneFileDirty(
  filePath: string,
  changedPaths: Set<string>,
  incremental: boolean,
): boolean {
  if (!incremental) return true;
  return changedPaths.has(filePath);
}
