import type { FeishuNodeType, FeishuTargetType } from '@feishu-md/shared';

export interface FeishuDocumentLinkTarget {
  feishuTargetType: FeishuTargetType;
  feishuNodeToken: string;
  feishuDocToken?: string;
  feishuNodeType?: FeishuNodeType;
  /** 飞书侧返回的权威访问链接（含租户域名），优先使用 */
  feishuUrl?: string;
}

export function toFeishuDocumentUrl(target: FeishuDocumentLinkTarget): string {
  if (target.feishuUrl) {
    return target.feishuUrl;
  }

  if (target.feishuTargetType === 'wiki') {
    // 知识库目录节点也是 wiki 节点（占位文档），须走 /wiki/ 而非 /drive/folder/
    return `https://feishu.cn/wiki/${target.feishuNodeToken}`;
  }

  if (target.feishuNodeType === 'file') {
    return `https://feishu.cn/file/${target.feishuNodeToken}`;
  }

  if (target.feishuNodeType === 'folder') {
    return `https://feishu.cn/drive/folder/${target.feishuNodeToken}`;
  }

  const token = target.feishuDocToken ?? target.feishuNodeToken;
  return `https://feishu.cn/docx/${token}`;
}
