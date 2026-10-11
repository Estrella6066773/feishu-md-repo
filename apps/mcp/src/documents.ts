import {
  getWikiNodeByToken,
  parseFeishuDocumentUrl,
  type FeishuClient,
} from '@feishu-md/feishu';

/**
 * 读写工具统一的文档定位结果。
 * documentId 给 docx 正文接口；url 给导出接口和返回给调用方的链接。
 * wiki 文档还会带上 spaceId / nodeToken，改标题时要两边一起更新。
 */
export interface ResolvedDocument {
  documentId: string;
  url: string;
  source: 'docx' | 'wiki';
  title?: string;
  spaceId?: string;
  nodeToken?: string;
}

/**
 * 接受三种输入：完整链接、含 /docx/ 或 /wiki/ 的路径、单独的 token。
 * 单独 token 先按知识库节点查；查不到就当作云文档 document_id。
 * 知识库节点查不到且 token 无效时，后续 docx 接口会返回飞书侧错误。
 */
export async function resolveDocument(client: FeishuClient, input: string): Promise<ResolvedDocument> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('请提供飞书文档链接（含 /docx/ 或 /wiki/）或文档 token');
  }

  const parsed = parseFeishuDocumentUrl(trimmed);
  if (parsed?.source === 'wiki') {
    const node = await getWikiNodeByToken(client, parsed.token, 'wiki');
    if (!node?.docToken) {
      throw new Error('无法解析该知识库链接：文档不存在，或当前应用没有该节点的读取权限。');
    }
    return fromWikiNode(node);
  }

  if (parsed?.source === 'docx') {
    const node = await getWikiNodeByToken(client, parsed.token, 'docx');
    if (node?.docToken) return fromWikiNode(node);
    return {
      documentId: parsed.token,
      url: `https://feishu.cn/docx/${parsed.token}`,
      source: 'docx',
    };
  }

  const node = await getWikiNodeByToken(client, trimmed);
  if (node?.docToken) return fromWikiNode(node);

  return {
    documentId: trimmed,
    url: `https://feishu.cn/docx/${trimmed}`,
    source: 'docx',
  };
}

function fromWikiNode(node: {
  docToken: string;
  nodeToken: string;
  spaceId: string;
  title?: string;
  url?: string;
}): ResolvedDocument {
  return {
    documentId: node.docToken,
    url: node.url ?? `https://feishu.cn/wiki/${node.nodeToken}`,
    source: 'wiki',
    title: node.title,
    spaceId: node.spaceId,
    nodeToken: node.nodeToken,
  };
}
