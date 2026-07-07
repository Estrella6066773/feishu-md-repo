import type { FeishuClient, NodeRef } from './client.js';
import { createLogger } from '@feishu-md/shared';
import { FeishuApiError, withRateLimit } from './api-error.js';
import { getWikiNodeByToken } from './wiki-service.js';

const nodeLog = createLogger('node-exists');

function isRemoteNodeNotFound(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    if (error.code === 404 || error.code === 99991663) return true;
    const message = error.message.toLowerCase();
    return (
      message.includes('not found') ||
      message.includes('not exist') ||
      message.includes('不存在') ||
      message.includes('未找到') ||
      message.includes('deleted')
    );
  }
  return false;
}

function isNotFoundResponse(code?: number, message?: string): boolean {
  if (
    code === 404
    || code === 99991663
    || code === 1770002
    || code === 1770003
  ) {
    return true;
  }
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('not found')
    || lower.includes('not exist')
    || lower.includes('不存在')
    || lower.includes('resource deleted')
    || lower.includes('已删除')
  );
}

export async function wikiNodeExists(client: FeishuClient, ref: NodeRef): Promise<boolean> {
  const token = ref.nodeToken ?? ref.token;
  if (!token) return false;

  nodeLog.debug('校验 Wiki 节点是否存在', { nodeToken: token });
  const preferred = ref.nodeType === 'docx' ? 'docx' : 'wiki';
  const node = await getWikiNodeByToken(client, token, preferred);
  return node != null;
}

export async function driveNodeExists(client: FeishuClient, ref: NodeRef): Promise<boolean> {
  nodeLog.debug('校验 Drive 节点是否存在', { nodeToken: ref.token, nodeType: ref.nodeType });
  try {
    if (ref.nodeType === 'docx') {
      const documentId = ref.docToken ?? ref.token;
      if (!documentId) return false;
      const response = await withRateLimit(() =>
        client.docx.v1.document.get({
          path: { document_id: documentId },
        }),
      );
      if (response.code === 0) return true;
      if (isNotFoundResponse(response.code, response.msg)) return false;
      return false;
    }

    const fileToken = ref.token;
    if (!fileToken) return false;
    const docType = ref.nodeType === 'folder' ? 'folder' : 'file';
    const response = await withRateLimit(() =>
      client.drive.v1.meta.batchQuery({
        data: {
          request_docs: [{ doc_token: fileToken, doc_type: docType }],
        },
      }),
    );
    if (response.code !== 0) {
      return isNotFoundResponse(response.code, response.msg);
    }
    const metas = (response.data as { metas?: Array<{ doc_token?: string }> } | undefined)?.metas ?? [];
    return metas.some((meta) => meta.doc_token === fileToken);
  } catch (error) {
    if (isRemoteNodeNotFound(error)) return false;
    throw error;
  }
}
