import type { FeishuClient, NodeRef } from './client.js';
import { createLogger } from '@feishu-md/shared';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
import { createEmptyDocument, replaceDocumentMarkdown } from './docx-content.js';

const wikiApiLog = createLogger('wiki-api');

export interface ResolvedWikiNode {
  spaceId: string;
  nodeToken: string;
  docToken: string;
  title?: string;
  /** 飞书返回的权威访问链接（含租户域名） */
  url?: string;
}

/** 通过 wiki node_token 或云文档 document_id 解析知识库节点 */
export async function getWikiNodeByToken(
  client: FeishuClient,
  token: string,
  preferredObjType: 'wiki' | 'docx' = 'wiki',
): Promise<ResolvedWikiNode | null> {
  const objTypes: Array<'wiki' | 'docx'> =
    preferredObjType === 'docx' ? ['docx', 'wiki'] : ['wiki', 'docx'];

  for (const objType of objTypes) {
    try {
      const response = await withRateLimit(
        () =>
          client.wiki.v2.space.getNode({
            params: { token, obj_type: objType },
          }),
        { read: true },
      );
      if (response.code !== 0) {
        if (isWikiNodeNotFound(response.msg)) continue;
        assertFeishuResponse(response, 'Get wiki node');
      }

      const node = response.data?.node;
      if (!node?.space_id || !node.node_token) continue;

      const docToken = node.obj_token ?? token;
      return {
        spaceId: node.space_id,
        nodeToken: node.node_token,
        docToken,
        title: node.title,
        url: (node as { url?: string }).url,
      };
    } catch (error) {
      if (error instanceof FeishuApiError && isWikiNodeNotFound(error.message)) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

function isWikiNodeNotFound(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('not found') ||
    lower.includes('not in wiki') ||
    lower.includes('不存在') ||
    lower.includes('未找到')
  );
}

export async function createWikiDocxNode(
  client: FeishuClient,
  options: {
    spaceId: string;
    parentNodeToken?: string;
    title: string;
  },
): Promise<NodeRef> {
  wikiApiLog.debug('创建 Wiki 文档节点', { title: options.title });
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
    url: (node as { url?: string }).url,
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
  wikiApiLog.debug('移动 Wiki 节点', { nodeToken: options.nodeToken });
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

export async function updateWikiNodeTitle(
  client: FeishuClient,
  options: {
    spaceId: string;
    nodeToken: string;
    title: string;
  },
): Promise<void> {
  wikiApiLog.debug('更新 Wiki 节点标题', { nodeToken: options.nodeToken, title: options.title });
  const response = await withRateLimit(() =>
    client.wiki.v2.spaceNode.updateTitle({
      path: {
        space_id: options.spaceId,
        node_token: options.nodeToken,
      },
      data: {
        title: options.title.slice(0, 800),
      },
    }),
  );
  assertFeishuResponse(response, 'Update wiki node title');
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
  const items: Array<{
    node_token?: string;
    obj_token?: string;
    title?: string;
    obj_type?: string;
  }> = [];
  let pageToken: string | undefined;
  wikiApiLog.debug('列出 Wiki 子节点', { parentToken: parentNodeToken ?? '(根)' });

  do {
    const response = await withRateLimit(
      () =>
        client.wiki.v2.spaceNode.list({
          path: { space_id: spaceId },
          params: {
            page_size: 50,
            parent_node_token: parentNodeToken,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }),
      { read: true },
    );
    assertFeishuResponse(response, 'List wiki child nodes');
    items.push(...(response.data?.items ?? []));

    if (!response.data?.has_more) break;
    pageToken = response.data?.page_token;
  } while (pageToken);

  return items.map((item) => ({
    nodeToken: item.node_token ?? '',
    objToken: item.obj_token,
    title: item.title,
    objType: item.obj_type ?? '',
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

/** 删除知识库节点是异步任务（级联删除大子树时返回 task_id），最多轮询 30 次 × 2s */
const WIKI_DELETE_POLL_ATTEMPTS = 30;
const WIKI_DELETE_POLL_INTERVAL_MS = 2_000;
/** 知识库开启删除审批，API 无法绕过 */
const WIKI_DELETE_ERR_CODE_APPROVAL_REQUIRED = 131011;
/** 子树过大，无法一次级联删除 */
const WIKI_DELETE_ERR_CODE_SUBTREE_TOO_LARGE = 131003;
const WIKI_DELETE_TASK_TYPE = 'delete_node';

type FeishuOpenResponse = { code?: number; msg?: string; data?: unknown };

type RequestableClient = FeishuClient & {
  request: (payload: {
    method: string;
    url: string;
    data?: unknown;
    params?: Record<string, unknown>;
  }) => Promise<FeishuOpenResponse>;
};

interface WikiDeleteTaskData {
  task_id?: string;
  task?: {
    simple_task_result?: {
      status?: string;
      status_msg?: string;
    };
  };
}

/**
 * 删除知识库节点。删除接口可能是同步完成（无 task_id），也可能是异步任务
 * （返回 task_id），后者需轮询查询任务状态。
 * @see https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/delete
 * @see https://open.feishu.cn/document/server-docs/docs/wiki-v2/task/get
 */
export async function deleteWikiNode(
  client: FeishuClient,
  options: { spaceId: string; nodeToken: string },
): Promise<void> {
  wikiApiLog.debug('删除 Wiki 节点', { nodeToken: options.nodeToken });
  const requestable = client as RequestableClient;
  const deleteUrl = `/open-apis/wiki/v2/spaces/${encodeURIComponent(options.spaceId)}/nodes/${encodeURIComponent(options.nodeToken)}`;

  try {
    const response = await withRateLimit(() =>
      requestable.request({
        method: 'DELETE',
        url: deleteUrl,
        data: { include_children: true },
      }),
    );
    assertFeishuResponse(response, 'Delete wiki node');

    const taskId = (response.data as WikiDeleteTaskData | undefined)?.task_id;
    if (!taskId) return;

    await pollWikiDeleteTask(requestable, taskId);
  } catch (error) {
    if (error instanceof FeishuApiError) {
      if (error.code === WIKI_DELETE_ERR_CODE_APPROVAL_REQUIRED) {
        throw new FeishuApiError(
          `${error.message}。该知识库开启了删除审批，无法通过 API 直接删除，请在飞书知识库中申请删除`,
          error.code,
        );
      }
      if (error.code === WIKI_DELETE_ERR_CODE_SUBTREE_TOO_LARGE) {
        throw new FeishuApiError(
          `${error.message}。子树过大无法一次级联删除，请先在飞书侧拆分或减少该节点下的内容`,
          error.code,
        );
      }
    }
    throw error;
  }
}

async function pollWikiDeleteTask(client: RequestableClient, taskId: string): Promise<void> {
  for (let attempt = 1; attempt <= WIKI_DELETE_POLL_ATTEMPTS; attempt += 1) {
    const response = await withRateLimit(
      () =>
        client.request({
          method: 'GET',
          url: `/open-apis/wiki/v2/tasks/${encodeURIComponent(taskId)}`,
          params: { task_type: WIKI_DELETE_TASK_TYPE },
        }),
      { read: true },
    );
    assertFeishuResponse(response, 'Get wiki delete node task');

    // 删除节点任务的状态挂在通用的 simple_task_result 下（不是 delete_node_result）
    const result = (response.data as WikiDeleteTaskData | undefined)?.task?.simple_task_result;
    const status = result?.status?.trim().toLowerCase();

    if (status === 'success') return;
    if (status === 'failure' || status === 'failed') {
      throw new FeishuApiError(
        `Wiki delete node task ${taskId} failed: ${result?.status_msg ?? status}`,
      );
    }

    if (attempt < WIKI_DELETE_POLL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, WIKI_DELETE_POLL_INTERVAL_MS));
    }
  }

  const timeoutSeconds = (WIKI_DELETE_POLL_ATTEMPTS * WIKI_DELETE_POLL_INTERVAL_MS) / 1000;
  throw new FeishuApiError(
    `Wiki delete node task ${taskId} did not complete within ${timeoutSeconds}s, please check the node status in Feishu`,
  );
}

export { createEmptyDocument, replaceDocumentMarkdown };
