import type { FeishuClient, FeishuTargetAdapter } from '../client.js';
import type { FeishuTarget } from '@feishu-md/shared';
import { WikiAdapter } from './wiki-adapter.js';
import { DriveAdapter } from './drive-adapter.js';

export function createTargetAdapter(target: FeishuTarget, client: FeishuClient): FeishuTargetAdapter {
  switch (target.type) {
    case 'wiki':
      return new WikiAdapter(client, target);
    case 'drive':
      return new DriveAdapter(client, target);
    default: {
      const exhaustive: never = target.type;
      throw new Error(`Unsupported Feishu target type: ${exhaustive}`);
    }
  }
}
