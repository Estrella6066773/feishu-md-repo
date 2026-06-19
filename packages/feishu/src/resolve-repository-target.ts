import type { FeishuClient } from './client.js';
import type { FeishuTarget } from '@feishu-md/shared';
import { getWikiNodeByToken, type ResolvedWikiNode } from './wiki-service.js';

export interface ResolvedRepositoryTarget {
  target: FeishuTarget;
  /** 用户指定的父文档（根 README 写入此文档，子目录挂在其 node 下） */
  rootDocument?: ResolvedWikiNode;
}

function isDriveFolderToken(token: string): boolean {
  return token.startsWith('fld');
}

/**
 * 仓库模式：解析飞书目标。
 * - Drive + 云文档 document_id → 若文档在知识库有节点，转为 Wiki 目标
 * - Wiki + 仅填父 token（docx 或 node）→ 自动补全 space_id 并规范为 node_token
 */
export async function resolveRepositoryFeishuTarget(
  client: FeishuClient,
  target: FeishuTarget,
): Promise<ResolvedRepositoryTarget> {
  if (target.type === 'drive') {
    const token = target.driveRootFolderToken?.trim();
    if (!token) {
      throw new Error('请填写云文档 token 或云空间文件夹 token');
    }
    if (isDriveFolderToken(token)) {
      throw new Error(
        '仓库模式需要「文档作父节点」：请填写云文档 docx 链接中的 document_id（不是 fld 开头的文件夹 token）。工作区模式才使用文件夹 token。',
      );
    }

    const node = await getWikiNodeByToken(client, token, 'docx');
    if (!node) {
      throw new Error(
        '该云文档未挂载到知识库，Open API 无法在其下创建子文档。请先将文档添加到知识库（或在飞书中把文档移入知识库），再重试同步。',
      );
    }

    return {
      target: {
        type: 'wiki',
        wikiSpaceId: node.spaceId,
        wikiRootNodeToken: node.nodeToken,
      },
      rootDocument: node,
    };
  }

  if (target.type === 'wiki') {
    const rootToken = target.wikiRootNodeToken?.trim();
    const spaceId = target.wikiSpaceId?.trim();

    if (rootToken) {
      const node = await getWikiNodeByToken(client, rootToken);
      if (!node) {
        throw new Error(
          '无法解析父文档 token：请确认应用有该文档/知识库节点权限；云文档须已挂载到知识库。',
        );
      }
      return {
        target: {
          type: 'wiki',
          wikiSpaceId: node.spaceId,
          wikiRootNodeToken: node.nodeToken,
        },
        rootDocument: node,
      };
    }

    if (!spaceId) {
      throw new Error('请填写 Wiki space_id，或填写父文档 token（支持 docx 链接中的 document_id）');
    }

    return {
      target: {
        type: 'wiki',
        wikiSpaceId: spaceId,
      },
    };
  }

  return { target };
}
