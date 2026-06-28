import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  GitProvider,
  GitProviderOptions,
  GitTreeEntry,
  ChangedPath,
  GitCommitSummary,
} from './types.js';

const execFileAsync = promisify(execFile);

abstract class BaseGitProvider implements GitProvider {
  protected git: SimpleGit;
  protected branch: string;
  protected repoPath: string;

  constructor(repoPath: string, branch: string) {
    this.repoPath = repoPath;
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

  async getCommitsBetween(
    sinceSha: string | undefined,
    untilSha: string,
  ): Promise<GitCommitSummary[]> {
    const args = sinceSha
      ? ['log', '--format=%H%x00%s%x00%b%x00', '-z', `${sinceSha}..${untilSha}`]
      : ['log', '-1', '--format=%H%x00%s%x00%b%x00', '-z', untilSha];
    const output = await this.git.raw(args);
    if (!output.trim()) return [];

    const parts = output.split('\0').filter((part) => part.length > 0);
    const commits: GitCommitSummary[] = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const sha = parts[i]!;
      const subject = parts[i + 1]!.trim();
      const body = parts[i + 2]!.replace(/\r\n/g, '\n').replace(/\n+$/, '');
      const message = body ? `${subject}\n\n${body}` : subject;
      commits.push({ sha, subject, message });
    }
    return commits;
  }

  async getCommitFilePaths(sha: string): Promise<string[]> {
    const output = await this.git.raw(['show', '--name-only', '--format=', sha]);
    if (!output.trim()) return [];
    return output
      .split('\n')
      .filter(Boolean)
      .map((path) => path.replace(/\\/g, '/'));
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

  async readBinaryFileAtSha(sha: string, path: string): Promise<Uint8Array | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.repoPath, 'cat-file', '-p', `${sha}:${path}`],
        { maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' },
      );
      if (!stdout || !Buffer.isBuffer(stdout) || stdout.length === 0) {
        return null;
      }
      return new Uint8Array(stdout);
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

/** 有云库同步前拉取远程；网络失败时降级使用本地已有 origin 快照，避免整次同步中断 */
export async function fetchRemoteForSync(git: GitProvider): Promise<void> {
  if (!git.fetchLatest) return;

  try {
    await git.fetchLatest();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sync] git fetch 失败，使用本地已有远程分支快照继续: ${message}`);
  }
}
