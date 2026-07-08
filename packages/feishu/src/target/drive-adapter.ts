import type { FeishuClient, FeishuTargetAdapter, NodeRef, DirectChildRef } from '../client.js';
import type { FeishuTarget } from '@feishu-md/shared';
import { createLogger } from '@feishu-md/shared';
import {
  createDriveDocument,
  createDriveFolder,
  deleteDriveFile,
  ensureDriveTabularFile,
  findDriveChildByName,
  listDriveFolderChildren,
  moveDriveFile,
  replaceDocumentMarkdown,
} from '../drive-service.js';
import { driveNodeExists } from '../node-exists.js';

const adapterLog = createLogger('drive-adapter');

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

  async listDirectChildren(parentToken: string | undefined): Promise<DirectChildRef[]> {
    const folderToken = parentToken ?? this.rootFolderToken;
    adapterLog.debug('列出 Drive 子项', { parentToken: folderToken });
    const items = await listDriveFolderChildren(this.client, folderToken);
    return items
      .filter((item) => item.token)
      .map((item) => ({ tokens: [item.token] }));
  }

  async ensureFolder(
    gitPath: string,
    parentToken: string | undefined,
    title: string,
  ): Promise<NodeRef> {
    const parentFolderToken = parentToken ?? this.rootFolderToken;
    adapterLog.debug('确保 Drive 文件夹', { gitPath, operation: 'ensure_folder' });
    const existing = await findDriveChildByName(this.client, parentFolderToken, title);
    if (existing?.nodeType === 'folder') return existing;

    return createDriveFolder(this.client, {
      parentFolderToken,
      name: title,
    });
  }

  async nodeExists(ref: NodeRef): Promise<boolean> {
    return driveNodeExists(this.client, ref);
  }

  async ensureDocument(
    gitPath: string,
    parentToken: string | undefined,
    title: string,
    existing?: NodeRef,
  ): Promise<NodeRef> {
    adapterLog.debug('确保 Drive 文档', { gitPath, operation: 'ensure_doc' });
    if (existing?.docToken && (await this.nodeExists(existing))) {
      return existing;
    }

    if (existing && (await this.nodeExists(existing))) {
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

  async updateDocumentContent(
    docToken: string,
    markdown: string,
    options?: import('../docx-content.js').ReplaceDocumentMarkdownOptions,
  ): Promise<void> {
    adapterLog.debug('更新 Drive 文档正文', {
      documentId: docToken,
      sourcePath: options?.sourcePath,
      operation: 'write_content',
    });
    await replaceDocumentMarkdown(this.client, docToken, markdown, options);
  }

  async moveNode(token: string, newParentToken: string | undefined): Promise<void> {
    adapterLog.debug('移动 Drive 文件', { nodeToken: token, operation: 'move' });
    await moveDriveFile(this.client, {
      fileToken: token,
      type: 'docx',
      targetFolderToken: newParentToken ?? this.rootFolderToken,
    });
  }

  async deleteNode(token: string, nodeType: 'folder' | 'docx' | 'file'): Promise<void> {
    adapterLog.debug('删除 Drive 文件', { nodeToken: token, operation: 'delete', nodeType });
    await deleteDriveFile(this.client, { fileToken: token, type: nodeType });
  }

  async uploadTabularFile(
    parentToken: string | undefined,
    fileName: string,
    data: Uint8Array,
    existing?: NodeRef,
  ): Promise<NodeRef> {
    adapterLog.debug('上传表格原文件到云空间', { fileName, size: data.byteLength });
    return ensureDriveTabularFile(this.client, {
      parentFolderToken: parentToken ?? this.rootFolderToken,
      fileName,
      data,
      existing,
    });
  }
}
