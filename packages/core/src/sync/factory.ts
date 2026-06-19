import type { SyncMode } from '@feishu-md/shared';
import type { SyncPlanner } from './planner.js';
import { WorkspacePlanner } from './workspace-planner.js';
import { RepositoryPlanner } from './repository-planner.js';

export function createPlanner(mode: SyncMode): SyncPlanner {
  switch (mode) {
    case 'workspace':
      return new WorkspacePlanner();
    case 'repository':
      return new RepositoryPlanner();
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported sync mode: ${exhaustive}`);
    }
  }
}
