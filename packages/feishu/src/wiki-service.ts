import type { FeishuClient, NodeRef } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';
import { createEmptyDocument, replaceDocumentMarkdown } from './docx-content.js';

export async function createWikiDocxNode(
  client: FeishuClient,
  options: {
    spaceId: string;
    parentNodeToken?: string;
    title: string;
  },
): Promise<NodeRef> {
  const response = await withRateLimit(() =>
    client.wiki.v2.spaceNode.create({
      path: { space_id: options.spaceId },
      data: {
        obj_type: 'docx',
        node_type: 'origin',
        parent_node_token: options.parentNodeToken || undefined,
        title: options.title.slice(0, 800),
      },
    }),
  );
  assertFeishuResponse(response, 'Create wiki docx node');

  const node = response.data?.node;
  if (!node?.node_token || !node.obj_token) {
    throw new Error('Create wiki docx node returned incomplete node data');
  }

  return {
    token: node.obj_token,
    nodeType: 'docx',
    title: node.title ?? options.title,
    nodeToken: node.node_token,
    docToken: node.obj_token,
  };
}

export async function createWikiFolderNode(
  client: FeishuClient,
  options: {
    spaceId: string;
    parentNodeToken?: string;
    title: string;
  },
): Promise<NodeRef> {
  // Wiki OpenAPI 暂不支持 obj_type=folder，使用占位 docx 节点表达目录层级。
  const node = await createWikiDocxNode(client, options);
  await replaceDocumentMarkdown(client, node.docToken!, `/${options.title}`);
  return {
    ...node,
    nodeType: 'folder',
    token: node.nodeToken!,
  };
}

export async function moveWikiNode(
  client: FeishuClient,
  options: {
    spaceId: string;
    nodeToken: string;
    targetParentToken?: string;
  },
): Promise<void> {
  const response = await withRateLimit(() =>
    client.wiki.v2.spaceNode.move({
      path: {
        space_id: options.spaceId,
        node_token: options.nodeToken,
      },
      data: {
        target_parent_token: options.targetParentToken || undefined,
        target_space_id: options.spaceId,
      },
    }),
  );
  assertFeishuResponse(response, 'Move wiki node');
}

export async function listWikiChildNodes(
  client: FeishuClient,
  spaceId: string,
  parentNodeToken?: string,
): Promise<
  Array<{
    nodeToken: string;
    objToken?: string;
    title?: string;
    objType: string;
  }>
> {
  const response = await withRateLimit(() =>
    client.wiki.v2.spaceNode.list({
      path: { space_id: spaceId },
      params: {
        page_size: 50,
        parent_node_token: parentNodeToken,
      },
    }),
  );
  assertFeishuResponse(response, 'List wiki child nodes');

  return (response.data?.items ?? []).map((item) => ({
    nodeToken: item.node_token ?? '',
    objToken: item.obj_token,
    title: item.title,
    objType: item.obj_type,
  }));
}

export async function findWikiChildByTitle(
  client: FeishuClient,
  spaceId: string,
  parentNodeToken: string | undefined,
  title: string,
): Promise<NodeRef | null> {
  const items = await listWikiChildNodes(client, spaceId, parentNodeToken);
  const matched = items.find((item) => item.title === title);
  if (!matched?.nodeToken) return null;

  const isFolderPlaceholder = matched.objType === 'docx' && !matched.objToken;
  return {
    token: isFolderPlaceholder ? matched.nodeToken : (matched.objToken ?? matched.nodeToken),
    nodeToken: matched.nodeToken,
    docToken: matched.objToken,
    nodeType: matched.objType === 'docx' && matched.objToken ? 'docx' : 'folder',
    title: matched.title,
  };
}

export { createEmptyDocument, replaceDocumentMarkdown };
