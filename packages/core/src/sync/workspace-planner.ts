import { basename, dirname } from 'node:path';
import type { SyncPlan, SyncPlanContext, SyncPlanner } from './planner.js';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isMarkdown(path: string, extensions: string[]): boolean {
  return extensions.some((ext) => path.toLowerCase().endsWith(ext.toLowerCase()));
}

export class WorkspacePlanner implements SyncPlanner {
  async buildPlan(context: SyncPlanContext): Promise<SyncPlan> {
    const mdExtensions = ['.md', '.markdown'];
    const operations = [];

    for (const rawPath of context.treePaths) {
      const path = normalizePath(rawPath);
      if (path.endsWith('/')) continue;

      if (isMarkdown(path, mdExtensions)) {
        const content = await context.readMarkdown(path);
        if (content != null) {
          operations.push({
            type: 'update_doc' as const,
            gitPath: path,
            title: basename(path, '.md'),
            parentGitPath: dirname(path) === '.' ? '' : dirname(path),
            contentMarkdown: content,
          });
        }
        continue;
      }

      operations.push({
        type: 'ensure_folder' as const,
        gitPath: dirname(path) === '.' ? '' : dirname(path),
        title: basename(dirname(path)),
        parentGitPath: dirname(dirname(path)) === '.' ? '' : dirname(dirname(path)),
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
