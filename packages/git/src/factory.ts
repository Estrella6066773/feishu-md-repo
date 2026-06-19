import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitProvider, GitProviderOptions, GitTreeEntry, ChangedPath } from './types.js';

abstract class BaseGitProvider implements GitProvider {
  protected git: SimpleGit;
  protected branch: string;

  constructor(repoPath: string, branch: string) {
    this.git = simpleGit(repoPath);
    this.branch = branch;
  }

  abstract getHeadSha(): Promise<string>;

  async getChangedPaths(sinceSha: string, untilSha: string): Promise<ChangedPath[]> {
    const output = await this.git.raw(['diff', '--name-status', '-z', `${sinceSha}..${untilSha}`]);
    if (!output) return [];

    const parts = output.split('\0');
    const changes: ChangedPath[] = [];
    let i = 0;
    while (i < parts.length) {
      const status = parts[i++];
      if (!status) break;

      const code = status[0] ?? 'M';
      if (code === 'R') {
        const previousPath = parts[i++];
        const path = parts[i++];
        if (!previousPath || !path) break;
        changes.push({
          path: path.replace(/\\/g, '/'),
          previousPath: previousPath.replace(/\\/g, '/'),
          changeType: 'rename',
        });
        continue;
      }

      const path = parts[i++];
      if (!path) break;
      changes.push({
        path: path.replace(/\\/g, '/'),
        changeType: mapChangeType(code),
      });
    }
    return changes;
  }

  async getTreeAtSha(sha: string): Promise<GitTreeEntry[]> {
    const output = await this.git.raw(['ls-tree', '-r', sha]);
    if (!output.trim()) return [];

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s(\w+)\s([a-f0-9]+)\t(.+)$/);
        if (!match) return null;
        const [, mode, type, hash, path] = match;
        return {
          path: path!,
          type: type === 'tree' ? 'tree' : 'blob',
          mode: mode!,
          sha: hash!,
        } satisfies GitTreeEntry;
      })
      .filter((entry): entry is GitTreeEntry => entry !== null);
  }

  async readFileAtSha(sha: string, path: string): Promise<string | null> {
    try {
      return await this.git.show([`${sha}:${path}`]);
    } catch {
      return null;
    }
  }

  async listTrackedPathsAtSha(sha: string): Promise<string[]> {
    const output = await this.git.raw(['ls-files', '-z', '--with-tree', sha]);
    if (!output.trim()) return [];
    return output
      .split('\0')
      .filter(Boolean)
      .map((path) => path.replace(/\\/g, '/'));
  }

  async filterPathsByGitExportIgnore(sha: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];

    const excluded = new Set<string>();
    for (const path of paths) {
      try {
        const output = await this.git.raw(['check-attr', 'export-ignore', '--', path]);
        const line = output.trim();
        const match = line.match(/^(.+): export-ignore: (.+)$/);
        if (match && match[2]?.trim() === 'set') {
          excluded.add(path.replace(/\\/g, '/'));
        }
      } catch {
        // 无法读取属性时保留路径
      }
    }

    return paths.filter((path) => !excluded.has(path.replace(/\\/g, '/')));
  }

  protected async resolveBranchRef(): Promise<string> {
    return this.branch.startsWith('refs/') ? this.branch : `refs/heads/${this.branch}`;
  }
}

function mapChangeType(status: string): ChangedPath['changeType'] {
  if (status.startsWith('A')) return 'add';
  if (status.startsWith('D')) return 'delete';
  if (status.startsWith('R')) return 'rename';
  return 'modify';
}

export class LocalGitProvider extends BaseGitProvider {
  async getHeadSha(): Promise<string> {
    const ref = await this.resolveBranchRef();
    return this.git.revparse([ref]);
  }
}

export class CloudGitProvider extends BaseGitProvider {
  constructor(options: GitProviderOptions) {
    super(options.repoPath, options.branch);
  }

  async fetchLatest(): Promise<void> {
    await this.git.fetch(['origin', this.branch]);
  }

  async getRemoteHeadSha(): Promise<string | null> {
    try {
      const ref = `refs/remotes/origin/${this.branch}`;
      return await this.git.revparse([ref]);
    } catch {
      return null;
    }
  }

  async getLocalHeadSha(): Promise<string> {
    const ref = await this.resolveBranchRef();
    return this.git.revparse([ref]);
  }

  async getHeadSha(): Promise<string> {
    const remote = await this.getRemoteHeadSha();
    return remote ?? this.getLocalHeadSha();
  }
}

export function createGitProvider(options: GitProviderOptions, sourceType: 'local' | 'cloud'): GitProvider {
  if (sourceType === 'cloud') {
    return new CloudGitProvider(options);
  }
  return new LocalGitProvider(options.repoPath, options.branch);
}
