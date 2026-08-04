import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@feishu-md/shared';
import { simpleGit, type SimpleGit } from 'simple-git';
import { remoteUrlsEqual } from './remote-url.js';
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
  protected remoteUrl?: string;

  constructor(repoPath: string, branch: string, remoteUrl?: string) {
    this.repoPath = repoPath;
    this.remoteUrl = remoteUrl;
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
    if (this.branch.startsWith('refs/')) return this.branch;

    const configured = `refs/heads/${this.branch}`;
    if (this.branch && (await this.refExists(configured))) return configured;

    // 配置分支不存在（常见于默认 main 与仓库实际 master 不一致）：回退仓库当前分支
    const currentBranch = await this.getCurrentBranchName();
    if (currentBranch) {
      if (this.branch && currentBranch !== this.branch) {
        gitLog.warn(
          `绑定分支 "${this.branch}" 在仓库中不存在，已自动使用仓库当前分支 "${currentBranch}"`,
          { repoPath: this.repoPath },
        );
      }
      return `refs/heads/${currentBranch}`;
    }

    // 仓库处于分离头指针等无法确定当前分支时，回退远端默认分支
    try {
      await this.git.revparse(['refs/remotes/origin/HEAD']);
      return 'refs/remotes/origin/HEAD';
    } catch {
      // 忽略，交由下方统一报错
    }

    throw new Error(
      `无法解析分支 "${this.branch}"：仓库中不存在该分支，且无法确定仓库当前分支或远端默认分支`,
    );
  }

  /** 判断引用是否存在 */
  protected async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.revparse([ref]);
      return true;
    } catch {
      return false;
    }
  }

  /** 当前检出分支名；非分支（分离头指针）或读取失败时返回 null */
  protected async getCurrentBranchName(): Promise<string | null> {
    try {
      const output = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      const name = output.trim();
      return name && name !== 'HEAD' ? name : null;
    } catch {
      return null;
    }
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
    super(options.repoPath, options.branch, options.remoteUrl);
  }

  async fetchLatest(): Promise<void> {
    const remote = await this.resolveFetchRemote();
    const branch = await this.resolveRemoteBranchName(remote);
    // 显式 refspec 保证拉取结果写入 refs/remotes/origin/<branch>，供 getRemoteHeadSha 使用
    await this.git.fetch([remote, `${branch}:refs/remotes/origin/${branch}`]);
  }

  /**
   * 确定 fetch 目标：
   * 本地 origin 与填写的远程 URL 归一化一致时优先使用 origin（本机凭据已验证，拉取最稳）；
   * 不一致或本地缺失 origin 时才使用填写的远程 URL，并记录警告。
   */
  private async resolveFetchRemote(): Promise<string> {
    if (!this.remoteUrl) return 'origin';

    const originUrl = await readLocalOriginUrl(this.repoPath);
    if (!originUrl) return this.remoteUrl;

    if (remoteUrlsEqual(originUrl, this.remoteUrl)) return 'origin';

    gitLog.warn(
      `填写的远程 URL 与本地 origin（${originUrl}）不一致，将以填写的远程 URL 拉取`,
      { repoPath: this.repoPath },
    );
    return this.remoteUrl;
  }

  /**
   * 确定要拉取的远端分支：
   * 优先配置分支（存在于远端时）；否则回退到本地当前分支（配置默认 main 而远端实际为 master 的常见场景）。
   */
  private async resolveRemoteBranchName(remote: string): Promise<string> {
    const candidates = this.branch ? [this.branch] : [];
    const currentBranch = await this.getCurrentBranchName();
    if (currentBranch && !candidates.includes(currentBranch)) {
      candidates.push(currentBranch);
    }

    for (const branch of candidates) {
      try {
        const output = await this.git.raw(['ls-remote', '--heads', remote, branch]);
        if (output.trim()) return branch;
      } catch {
        // 网络不可用时尝试下一候选
      }
    }

    if (currentBranch) return currentBranch;
    return this.branch || 'HEAD';
  }

  async getRemoteHeadSha(): Promise<string | null> {
    const ref = `refs/remotes/origin/${this.branch}`;
    try {
      return await this.git.revparse([ref]);
    } catch {
      // 配置分支不存在：回退远端默认分支指向的引用
      try {
        return await this.git.revparse(['refs/remotes/origin/HEAD']);
      } catch {
        return null;
      }
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

/** 读取本地仓库配置的 origin 远程地址；未配置或读取失败时返回 null */
export async function readLocalOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin');
    return origin?.refs?.fetch ?? origin?.refs?.push ?? null;
  } catch {
    return null;
  }
}
