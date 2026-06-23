import type { FeishuNodeType, FeishuTargetType } from '@feishu-md/shared';

export interface FeishuDocumentLinkTarget {
  feishuTargetType: FeishuTargetType;
  feishuNodeToken: string;
  feishuDocToken?: string;
  feishuNodeType?: FeishuNodeType;
}

export function toFeishuDocumentUrl(target: FeishuDocumentLinkTarget): string {
  if (target.feishuTargetType === 'wiki') {
    return `https://feishu.cn/wiki/${target.feishuNodeToken}`;
  }

  if (target.feishuNodeType === 'folder') {
    return `https://feishu.cn/drive/folder/${target.feishuNodeToken}`;
  }

  const token = target.feishuDocToken ?? target.feishuNodeToken;
  return `https://feishu.cn/docx/${token}`;
}
