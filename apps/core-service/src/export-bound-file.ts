import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { listBindings, listNodeMappings, type DbClient } from '@feishu-md/db';
import { parseFeishuDocumentUrl } from '@feishu-md/feishu';
import type { Binding, RepositoryOptions } from '@feishu-md/shared';

export interface LocalBoundFile {
  bindingId: string;
  bindingName: string;
  gitPath: string;
  absolutePath: string;
}

const DEFAULT_README_NAMES = ['README.md', 'readme.md', 'Readme.md'];

/**
 * 用文档链接反查本地仓库绑定，得到应写回的 Markdown 文件。
 * 只认 sourceType 为 local 的绑定；有云仓库的检出目录不在这里写，避免和 fetch 互相覆盖。
 * 工作区模式的 gitPath 就是文件；仓库模式的 gitPath 是目录，正文在该目录的 README。
 */
export async function findLocalBoundFiles(
  db: DbClient,
  documentUrl: string,
): Promise<LocalBoundFile[]> {
  const parsed = parseFeishuDocumentUrl(documentUrl);
  if (!parsed) return [];

  const bindings = await listBindings(db);
  const hits: LocalBoundFile[] = [];

  for (const binding of bindings) {
    if (binding.sourceType !== 'local') continue;
    const mappings = await listNodeMappings(db, binding.id);
    for (const mapping of mappings) {
      if (mapping.feishuNodeType !== 'docx') continue;
      if (!mappingMatchesToken(mapping, parsed.token)) continue;
      const absolutePath = await resolveMarkdownFile(binding, mapping.gitPath);
      if (!absolutePath) continue;
      let safePath: string | null;
      try {
        safePath = await pathInsideRepo(binding.repoPath, absolutePath);
      } catch {
        safePath = null;
      }
      if (!safePath) continue;
      hits.push({
        bindingId: binding.id,
        bindingName: binding.name,
        gitPath: mapping.gitPath,
        absolutePath: safePath,
      });
    }
  }

  return hits;
}

/**
 * 把导出的 Markdown 写入绑定对应的本地文件。
 * 不改 node_mapping.contentSha，也不做 git commit。下次本地同步会把这次写入当成仓库变更，再推回飞书。
 * 多个文件时必须指定 bindingId 或 gitPath。路径会再按链接解析一次，调用方不能自带绝对路径。
 */
export async function writeBoundMarkdownFile(
  db: DbClient,
  documentUrl: string,
  markdown: string,
  bindingId?: string,
  gitPath?: string,
): Promise<LocalBoundFile> {
  const targets = await findLocalBoundFiles(db, documentUrl);
  if (targets.length === 0) {
    throw new Error('这篇文档没有绑在本地仓库的 Markdown 文件上');
  }

  const matches = targets.filter((item) => {
    if (bindingId && item.bindingId !== bindingId) return false;
    if (gitPath !== undefined && item.gitPath !== gitPath) return false;
    return true;
  });
  if (!bindingId && gitPath === undefined && targets.length !== 1) {
    throw new Error('这篇文档对应多个本地文件，请指定要写入的路径');
  }
  const target = matches.length === 1 ? matches[0] : undefined;
  if (!target) {
    throw new Error('这篇文档对应多个本地文件，请指定要写入的路径');
  }

  const bindings = await listBindings(db);
  const binding = bindings.find((item) => item.id === target.bindingId);
  if (!binding) {
    throw new Error('绑定不存在');
  }

  const safePath = await pathInsideRepo(binding.repoPath, target.absolutePath);
  if (!safePath) {
    throw new Error('目标文件不在本地仓库目录内');
  }
  await mkdir(dirname(safePath), { recursive: true });
  await writeFile(safePath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  return { ...target, absolutePath: safePath };
}

function mappingMatchesToken(
  mapping: { feishuDocToken?: string; feishuNodeToken: string; feishuUrl?: string },
  token: string,
): boolean {
  if (mapping.feishuDocToken === token) return true;
  if (mapping.feishuNodeToken === token) return true;
  return Boolean(mapping.feishuUrl?.includes(`/${token}`));
}

async function resolveMarkdownFile(binding: Binding, gitPath: string): Promise<string | null> {
  const relativePath = gitPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/\.(md|markdown)$/i.test(relativePath)) {
    return resolve(binding.repoPath, relativePath);
  }
  if (binding.syncMode !== 'repository') return null;

  const names = readmeNames(binding);
  const directory = relativePath ? resolve(binding.repoPath, relativePath) : resolve(binding.repoPath);
  for (const name of names) {
    const candidate = join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续找下一个 README 文件名
    }
  }
  const fallback = names[0] ?? 'README.md';
  return join(directory, fallback);
}

function readmeNames(binding: Binding): string[] {
  if (binding.syncMode !== 'repository') return DEFAULT_README_NAMES;
  const names = (binding.options as RepositoryOptions).readmeNames;
  return names?.length ? names : DEFAULT_README_NAMES;
}

/** 解析后的文件必须落在仓库根目录里面。不创建目录；仓库根不存在时返回 null。 */
async function pathInsideRepo(repoPath: string, absoluteFile: string): Promise<string | null> {
  let root: string;
  try {
    root = await realpath(resolve(repoPath));
  } catch {
    return null;
  }

  const unresolved = resolve(absoluteFile);
  let filePath = unresolved;
  try {
    const realParent = await realpath(dirname(unresolved));
    filePath = join(realParent, basename(unresolved));
  } catch {
    filePath = unresolved;
  }

  const rel = relative(root, filePath);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  return filePath;
}
