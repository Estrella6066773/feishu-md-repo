import { basename, dirname } from 'node:path';
import type { SyncPlan, SyncPlanContext, SyncPlanner } from './planner.js';

const README_NAMES = new Set(['README.md', 'readme.md', 'Readme.md']);

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function directoryPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized.endsWith('/') ? normalized.slice(0, -1) : dirname(normalized);
}

export class RepositoryPlanner implements SyncPlanner {
  async buildPlan(context: SyncPlanContext): Promise<SyncPlan> {
    const directories = new Set<string>(['']);

    for (const rawPath of context.treePaths) {
      const path = normalizePath(rawPath);
      let current = dirname(path);
      while (true) {
        directories.add(current === '.' ? '' : current);
        if (current === '.' || current === '') break;
        current = dirname(current);
      }
    }

    const operations = [];

    for (const dir of directories) {
      const readmePath = Array.from(README_NAMES)
        .map((name) => (dir ? `${dir}/${name}` : name))
        .find((candidate) => context.treePaths.map(normalizePath).includes(candidate));

      if (!readmePath) continue;

      const content = await context.readMarkdown(readmePath);
      if (content == null) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: dir,
        title: dir ? basename(dir) : basename(context.bindingId),
        parentGitPath: dir ? (dirname(dir) === '.' ? '' : dirname(dir)) : undefined,
        contentMarkdown: content,
      });
    }

    return {
      bindingId: context.bindingId,
      trigger: context.trigger,
      fromSha: context.fromSha,
      toSha: context.toSha,
      operations,
    };
  }
}
