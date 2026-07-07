import type { FeishuClient, FeishuTargetAdapter, NodeRef, DirectChildRef } from '../client.js';
import type { FeishuTarget } from '@feishu-md/shared';
import { createLogger } from '@feishu-md/shared';
import {
  createWikiDocxNode,
  createWikiFolderNode,
  deleteWikiNode,
  findWikiChildByTitle,
  listWikiChildNodes,
  moveWikiNode,
  replaceDocumentMarkdown,
} from '../wiki-service.js';
import { wikiNodeExists } from '../node-exists.js';

const adapterLog = createLogger('wiki-adapter');

export class WikiAdapter implements FeishuTargetAdapter {
  readonly type = 'wiki' as const;

  private spaceId: string;

  private rootNodeToken?: string;

  constructor(
    private client: FeishuClient,
    target: FeishuTarget,
  ) {
    if (!target.wikiSpaceId) {
      throw new Error('wikiSpaceId is required for Wiki target');
    }
    this.spaceId = target.wikiSpaceId;
    this.rootNodeToken = target.wikiRootNodeToken;
  }

  getRootParentToken(): string | undefined {
    return this.rootNodeToken;
  }

  async listDirectChildren(parentToken: string | undefined): Promise<DirectChildRef[]> {
    adapterLog.debug('列出 Wiki 子节点', { parentToken: parentToken ?? '(根)' });
    const items = await listWikiChildNodes(this.client, this.spaceId, parentToken);
    return items
      .filter((item) => item.nodeToken)
      .map((item) => ({
        tokens: [item.nodeToken, item.objToken].filter((token): token is string => Boolean(token)),
      }));
  }

  async ensureFolder(
    gitPath: string,
    parentToken: string | undefined,
    title: string,
  ): Promise<NodeRef> {
    adapterLog.debug('确保 Wiki 文件夹', { gitPath, operation: 'ensure_folder' });
    const existing = await findWikiChildByTitle(this.client, this.spaceId, parentToken, title);
    if (existing) return { ...existing, nodeType: 'folder' };

    return createWikiFolderNode(this.client, {
      spaceId: this.spaceId,
      parentNodeToken: parentToken,
      title,
    });
  }

  async nodeExists(ref: NodeRef): Promise<boolean> {
    return wikiNodeExists(this.client, ref);
  }

  async ensureDocument(
    gitPath: string,
    parentToken: string | undefined,
    title: string,
    existing?: NodeRef,
  ): Promise<NodeRef> {
    adapterLog.debug('确保 Wiki 文档', { gitPath, operation: 'ensure_doc' });
    if (existing?.docToken && (await this.nodeExists(existing))) {
      return existing;
    }

    if (existing && (await this.nodeExists(existing))) {
      return existing;
    }

    const matched = await findWikiChildByTitle(this.client, this.spaceId, parentToken, title);
    if (matched?.docToken) {
      return matched;
    }

    return createWikiDocxNode(this.client, {
      spaceId: this.spaceId,
      parentNodeToken: parentToken,
      title,
    });
  }

  async updateDocumentContent(
    docToken: string,
    markdown: string,
    options?: import('../docx-content.js').ReplaceDocumentMarkdownOptions,
  ): Promise<void> {
    adapterLog.debug('更新 Wiki 文档正文', {
      documentId: docToken,
      sourcePath: options?.sourcePath,
      operation: 'write_content',
    });
    await replaceDocumentMarkdown(this.client, docToken, markdown, options);
  }

  async moveNode(token: string, newParentToken: string | undefined): Promise<void> {
    adapterLog.debug('移动 Wiki 节点', { nodeToken: token, operation: 'move' });
    await moveWikiNode(this.client, {
      spaceId: this.spaceId,
      nodeToken: token,
      targetParentToken: newParentToken,
    });
  }

  async deleteNode(token: string, _nodeType: 'folder' | 'docx' | 'file'): Promise<void> {
    adapterLog.debug('删除 Wiki 节点', { nodeToken: token, operation: 'delete' });
    await deleteWikiNode(this.client, { spaceId: this.spaceId, nodeToken: token });
  }
}
