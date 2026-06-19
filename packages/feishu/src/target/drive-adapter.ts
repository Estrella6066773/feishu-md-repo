import type { FeishuClient, FeishuTargetAdapter, NodeRef } from '../client.js';
import type { FeishuTarget } from '@feishu-md/shared';
import {
  createDriveDocument,
  createDriveFolder,
  findDriveChildByName,
  moveDriveFile,
  replaceDocumentMarkdown,
} from '../drive-service.js';

export class DriveAdapter implements FeishuTargetAdapter {
  readonly type = 'drive' as const;
  private rootFolderToken: string;

  constructor(
    private client: FeishuClient,
    target: FeishuTarget,
  ) {
    if (!target.driveRootFolderToken) {
      throw new Error('driveRootFolderToken is required for Drive target');
    }
    this.rootFolderToken = target.driveRootFolderToken;
  }

  getRootParentToken(): string | undefined {
    return this.rootFolderToken;
  }

  async ensureFolder(
    _gitPath: string,
    parentToken: string | undefined,
    title: string,
  ): Promise<NodeRef> {
    const parentFolderToken = parentToken ?? this.rootFolderToken;
    const existing = await findDriveChildByName(this.client, parentFolderToken, title);
    if (existing?.nodeType === 'folder') return existing;

    return createDriveFolder(this.client, {
      parentFolderToken,
      name: title,
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

    const parentFolderToken = parentToken ?? this.rootFolderToken;
    const matched = await findDriveChildByName(this.client, parentFolderToken, title);
    if (matched?.nodeType === 'docx' && matched.docToken) {
      return matched;
    }

    return createDriveDocument(this.client, {
      parentFolderToken,
      title,
    });
  }

  async updateDocumentContent(docToken: string, markdown: string): Promise<void> {
    await replaceDocumentMarkdown(this.client, docToken, markdown);
  }

  async moveNode(token: string, newParentToken: string | undefined): Promise<void> {
    await moveDriveFile(this.client, {
      fileToken: token,
      type: 'docx',
      targetFolderToken: newParentToken ?? this.rootFolderToken,
    });
  }

  async deleteNode(_token: string): Promise<void> {
    // 删除云空间文件需额外 trash/delete 权限，后续阶段再接入。
  }
}
