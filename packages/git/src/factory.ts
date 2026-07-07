import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@feishu-md/shared';
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
    let shas: string[];
    if (!sinceSha || sinceSha === untilSha) {
      shas = [untilSha];
    } else {
      const output = await this.git.raw(['log', '--format=%H', '-z', `${sinceSha}..${untilSha}`]);
      shas = parseGitLogShaList(output);
      if (shas.length === 0) {
        shas = [untilSha];
      }
    }

    const commits: GitCommitSummary[] = [];
    for (const sha of shas) {
      commits.push(await this.readCommitSummary(sha));
    }
    return commits;
  }

  protected async readCommitSummary(sha: string): Promise<GitCommitSummary> {
    const raw = await this.git.raw(['cat-file', '-p', sha]);
    return parseCommitObjectToSummary(sha, raw);
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

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalizeCommitText(text: string): string {
  return text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function parseGitLogShaList(output: string): string[] {
  return normalizeCommitText(output)
    .split('\0')
    .map((part) => part.replace(/^\ufeff/, '').trim())
    .filter((part) => GIT_SHA_PATTERN.test(part));
}

function parseCommitObjectToSummary(sha: string, raw: string): GitCommitSummary {
  const normalized = raw.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  const messageText = headerEnd >= 0 ? normalized.slice(headerEnd + 2).replace(/\n$/, '') : '';

  const firstNewline = messageText.indexOf('\n');
  let subject: string;
  let body: string;
  if (firstNewline >= 0) {
    subject = messageText.slice(0, firstNewline).trim();
    body = messageText.slice(firstNewline + 1).replace(/^\n+/, '');
  } else {
    subject = messageText.trim();
    body = '';
  }

  const message = body ? `${subject}\n\n${body}` : subject;
  return { sha, subject, body, message };
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
const gitLog = createLogger('git');

export async function fetchRemoteForSync(git: GitProvider): Promise<void> {
  if (!git.fetchLatest) return;

  try {
    await git.fetchLatest();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gitLog.warn(`git fetch 失败，使用本地已有远程分支快照继续: ${message}`);
  }
}
