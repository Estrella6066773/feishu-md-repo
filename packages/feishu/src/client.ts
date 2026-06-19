import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuCredentials, FeishuTarget, FeishuTargetType } from '@feishu-md/shared';

export type FeishuClient = lark.Client;

export function createFeishuClient(credentials: FeishuCredentials): FeishuClient {
  return new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
}

export interface NodeRef {
  /** Primary identifier used by the adapter caller (node_token / folder_token / document_id). */
  token: string;
  nodeType: 'folder' | 'docx' | 'file';
  title?: string;
  /** Docx document_id / obj_token for content APIs. */
  docToken?: string;
  /** Wiki node_token when applicable. */
  nodeToken?: string;
}

export interface FeishuTargetAdapter {
  readonly type: FeishuTargetType;
  getRootParentToken(): string | undefined;
  ensureFolder(gitPath: string, parentToken: string | undefined, title: string): Promise<NodeRef>;
  ensureDocument(
    gitPath: string,
    parentToken: string | undefined,
    title: string,
    existing?: NodeRef,
  ): Promise<NodeRef>;
  updateDocumentContent(docToken: string, markdown: string): Promise<void>;
  moveNode(token: string, newParentToken: string | undefined): Promise<void>;
  deleteNode(token: string): Promise<void>;
  uploadFile?(
    gitPath: string,
    parentToken: string | undefined,
    fileName: string,
    content: Uint8Array,
  ): Promise<NodeRef>;
}

export { createTargetAdapter } from './target/factory.js';
export { WikiAdapter } from './target/wiki-adapter.js';
export { DriveAdapter } from './target/drive-adapter.js';
export { FeishuApiError } from './api-error.js';
export { replaceDocumentMarkdown } from './docx-content.js';
