import type { FeishuClient } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';
import {
  findDocumentPageBlock,
  getChildBlockAtIndex,
  insertDocumentBlockChildrenAt,
  listDocumentBlocks,
} from './docx-block-service.js';

const BOARD_BLOCK_TYPE = 43;

type FeishuOpenResponse = { code?: number; msg?: string; data?: unknown };

type RequestableClient = FeishuClient & {
  request: (payload: {
    method: string;
    url: string;
    data?: unknown;
    params?: Record<string, unknown>;
  }) => Promise<FeishuOpenResponse>;
};

interface BoardNode {
  id?: string;
}

export interface BoardMindMapLinkNode {
  id: string;
  label: string;
  url: string;
  parentId?: string;
  zIndex: number;
  isRoot?: boolean;
  layoutPosition?: 'left' | 'right' | 'up' | 'down';
}

function buildPlainMindMapText(label: string): Record<string, unknown> {
  return { text: label.slice(0, 1024) };
}

/** 与飞书画板 composite_shape 内 link_element 结构一致 */
function buildLinkMindMapText(label: string, url: string): Record<string, unknown> {
  return {
    rich_text: {
      paragraphs: [
        {
          paragraph_type: 0,
          elements: [
            {
              element_type: 1,
              link_element: {
                herf: url.slice(0, 1000),
                text: label.slice(0, 10000),
              },
            },
          ],
        },
      ],
    },
  };
}

function buildMentionDocMindMapText(url: string): Record<string, unknown> {
  return {
    rich_text: {
      paragraphs: [
        {
          paragraph_type: 0,
          elements: [
            {
              element_type: 3,
              mention_doc_element: {
                doc_url: url.slice(0, 1000),
              },
            },
          ],
        },
      ],
    },
  };
}

function isFeishuDocUrl(url: string): boolean {
  return /^https?:\/\/[^/]+\/(wiki|docx)\//.test(url);
}

type MindMapTextMode = 'plain' | 'link' | 'mention_doc';

function buildMindMapNodeText(
  label: string,
  url: string,
  isRoot: boolean,
  mode: MindMapTextMode,
): Record<string, unknown> {
  if (isRoot || mode === 'plain') {
    return buildPlainMindMapText(label);
  }
  if (mode === 'mention_doc' && isFeishuDocUrl(url)) {
    return buildMentionDocMindMapText(url);
  }
  if (!url || !/^https?:\/\//.test(url)) {
    return buildPlainMindMapText(label);
  }
  return buildLinkMindMapText(label, url);
}

function buildBoardMindMapNodePayload(
  node: BoardMindMapLinkNode,
  textMode: MindMapTextMode = 'link',
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: node.id,
    type: 'mind_map',
    text: buildMindMapNodeText(node.label, node.url, Boolean(node.isRoot), textMode),
  };

  if (node.isRoot) {
    payload.mind_map_root = {
      layout: 'left_right',
      type: 'mind_map_round_rect',
      line_style: 'round_angle',
    };
    return payload;
  }

  const mindMapNode: Record<string, unknown> = {
    parent_id: node.parentId,
    type: 'mind_map_text',
    z_index: node.zIndex,
  };
  if (node.layoutPosition) {
    mindMapNode.layout_position = node.layoutPosition;
  }
  payload.mind_map_node = mindMapNode;
  return payload;
}

async function createMindMapNodeBatch(
  client: FeishuClient,
  whiteboardId: string,
  nodes: BoardMindMapLinkNode[],
  textMode: MindMapTextMode,
): Promise<void> {
  if (nodes.length === 0) return;

  const payloads = nodes.map((node) =>
    buildBoardMindMapNodePayload(node, node.isRoot ? 'plain' : textMode),
  );
  const response = await withRateLimit(() =>
    client.board.v1.whiteboardNode.create({
      path: { whiteboard_id: whiteboardId },
      data: { nodes: payloads as never },
    }),
  );
  assertFeishuResponse(response, 'Create board mind map nodes batch');
}

async function createBoardMindMapNodes(
  client: FeishuClient,
  whiteboardId: string,
  nodes: BoardMindMapLinkNode[],
): Promise<void> {
  if (nodes.length === 0) return;

  // 飞书仅在同一 create 批次内认可自定义 parent_id；逐节点创建会 2890002
  const modes: MindMapTextMode[] = ['link', 'mention_doc', 'plain'];

  for (const mode of modes) {
    try {
      await createMindMapNodeBatch(client, whiteboardId, nodes, mode);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mode === modes[modes.length - 1]) {
        throw error instanceof Error ? error : new Error(message);
      }
      console.warn(`[sync] 思维导图批量 ${mode} 创建失败，尝试下一种: ${message}`);
    }
  }
}

/** 用原生思维导图节点（link_element 超链接）刷新画板 */
export async function replaceBoardLinkMindMap(
  client: FeishuClient,
  whiteboardId: string,
  nodes: BoardMindMapLinkNode[],
): Promise<void> {
  if (nodes.length === 0) return;
  await clearBoardNodes(client, whiteboardId);
  await createBoardMindMapNodes(client, whiteboardId, nodes);
}

async function feishuRequest(
  client: FeishuClient,
  method: 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<FeishuOpenResponse> {
  const url = apiPath.startsWith('/open-apis') ? apiPath : `/open-apis${apiPath}`;
  const response = await withRateLimit(() =>
    (client as RequestableClient).request({
      method,
      url,
      data: body,
    }),
  );
  assertFeishuResponse(response, `${method} ${apiPath}`);
  return response;
}

/** 在 docx 指定位置插入画板块，返回 whiteboard_id */
export async function insertBoardBlock(
  client: FeishuClient,
  documentId: string,
  index: number,
): Promise<string> {
  await insertDocumentBlockChildrenAt(
    client,
    documentId,
    index,
    [
      {
        block_type: BOARD_BLOCK_TYPE,
        board: {},
      },
    ],
    'Insert board block',
  );

  const whiteboardId = await getWhiteboardIdAtChildIndex(client, documentId, index);
  if (!whiteboardId) {
    throw new Error('Board block was inserted but whiteboard_id is unavailable');
  }
  return whiteboardId;
}

/** 将 Mermaid / 流程图代码导入画板 */
export async function importBoardMermaidDiagram(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
  diagramType = 0,
): Promise<void> {
  await clearBoardNodes(client, whiteboardId);

  const response = await withRateLimit(() =>
    client.board.v1.whiteboardNode.createPlantuml({
      path: { whiteboard_id: whiteboardId },
      data: {
        plant_uml_code: mermaidCode,
        syntax_type: 2,
        diagram_type: diagramType,
        style_type: 1,
      },
    }),
  );
  assertFeishuResponse(response, 'Import board mermaid diagram');
}

async function getWhiteboardIdAtChildIndex(
  client: FeishuClient,
  documentId: string,
  childIndex: number,
): Promise<string | null> {
  const block = await getChildBlockAtIndex(client, documentId, childIndex, {
    blockType: BOARD_BLOCK_TYPE,
    action: 'List docx blocks for board index',
  });
  return block?.board?.token ?? null;
}

/** 在 docx 正文中查找或插入画板块，返回 whiteboard_id */
export async function ensureWhiteboardInDocument(
  client: FeishuClient,
  documentId: string,
): Promise<string> {
  const existing = await findBoardWhiteboardId(client, documentId);
  if (existing) return existing;

  const items = await listDocumentBlocks(client, documentId, 'List docx blocks for board append');
  const pageBlock = findDocumentPageBlock(items, documentId);
  const index = pageBlock?.children?.length ?? 0;

  return insertBoardBlock(client, documentId, index);
}

async function findBoardWhiteboardId(
  client: FeishuClient,
  documentId: string,
): Promise<string | null> {
  const items = await listDocumentBlocks(client, documentId, 'List docx blocks for board');

  for (const item of items) {
    if (item.block_type !== BOARD_BLOCK_TYPE) continue;
    const token = item.board?.token;
    if (token) return token;
  }
  return null;
}

export async function listBoardNodeIds(client: FeishuClient, whiteboardId: string): Promise<string[]> {
  const response = await withRateLimit(() =>
    client.board.v1.whiteboardNode.list({
      path: { whiteboard_id: whiteboardId },
    }),
  );
  assertFeishuResponse(response, 'List board nodes');

  const nodes = (response.data as { nodes?: BoardNode[] } | undefined)?.nodes ?? [];
  return nodes.map((node) => node.id).filter((id): id is string => Boolean(id));
}

export async function clearBoardNodes(client: FeishuClient, whiteboardId: string): Promise<void> {
  const ids = await listBoardNodeIds(client, whiteboardId);
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    if (chunk.length === 0) continue;
    await feishuRequest(
      client,
      'DELETE',
      `/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes/batch_delete`,
      { ids: chunk },
    );
  }
}

/** 用 Mermaid 思维导图刷新画板 */
export async function replaceBoardMindMap(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
): Promise<void> {
  await importBoardMermaidDiagram(client, whiteboardId, mermaidCode, 1);
}
