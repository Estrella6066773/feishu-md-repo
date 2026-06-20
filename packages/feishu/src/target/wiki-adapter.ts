import type { FeishuClient, FeishuTargetAdapter, NodeRef } from '../client.js';

import type { FeishuTarget } from '@feishu-md/shared';

import {
  createWikiDocxNode,
  createWikiFolderNode,
  deleteWikiNode,
  findWikiChildByTitle,
  moveWikiNode,
  replaceDocumentMarkdown,
} from '../wiki-service.js';



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



  async ensureFolder(

    _gitPath: string,

    parentToken: string | undefined,

    title: string,

  ): Promise<NodeRef> {

    const existing = await findWikiChildByTitle(this.client, this.spaceId, parentToken, title);

    if (existing) return { ...existing, nodeType: 'folder' };



    return createWikiFolderNode(this.client, {

      spaceId: this.spaceId,

      parentNodeToken: parentToken,

      title,

    });

  }



  async ensureDocument(

    _gitPath: string,

    parentToken: string | undefined,

    title: string,

    existing?: NodeRef,

  ): Promise<NodeRef> {

    if (existing?.docToken) {

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



  async updateDocumentContent(docToken: string, markdown: string): Promise<void> {

    await replaceDocumentMarkdown(this.client, docToken, markdown);

  }



  async moveNode(token: string, newParentToken: string | undefined): Promise<void> {

    await moveWikiNode(this.client, {

      spaceId: this.spaceId,

      nodeToken: token,

      targetParentToken: newParentToken,

    });

  }



  async deleteNode(token: string, _nodeType: 'folder' | 'docx' | 'file'): Promise<void> {
    await deleteWikiNode(this.client, { spaceId: this.spaceId, nodeToken: token });
  }

}


