/**
 * 探测 mind_map 顺序/批量创建与链接 payload。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { clearBoardNodes, createFeishuClient, ensureWhiteboardInDocument } from '@feishu-md/feishu';

const DOC_ID = process.argv[2] ?? 'WF2EdWcLeoeelvxIXLhcyjxDnph';
const TEST_URL = 'https://feishu.cn/docx/RrkJdUHs2oSgkBxK68Mc1EO6nxh';

type FeishuResponse = { code?: number; msg?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createNodes(
  client: ReturnType<typeof createFeishuClient>,
  whiteboardId: string,
  nodes: unknown[],
): Promise<FeishuResponse> {
  return client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: whiteboardId },
    data: { nodes: nodes as never },
  }) as Promise<FeishuResponse>;
}

async function safeClear(client: ReturnType<typeof createFeishuClient>, whiteboardId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await clearBoardNodes(client, whiteboardId);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('not ready') && !message.includes('applying')) throw error;
      await sleep(800);
    }
  }
}

async function main(): Promise<void> {
  const dataDir =
    process.env.FEISHU_MD_DATA_DIR ?? join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo');
  const { db } = createDb({ dbPath: join(dataDir, 'app.db'), runMigrations: false });
  const credentials = await getFeishuCredentials(db);
  if (!credentials) throw new Error('无飞书凭证');

  const client = createFeishuClient(credentials);
  const whiteboardId = await ensureWhiteboardInDocument(client, DOC_ID);
  console.log('whiteboard_id:', whiteboardId);

  await safeClear(client, whiteboardId);

  // 1) 顺序：root -> 等待 -> child plain
  {
    let r = await createNodes(client, whiteboardId, [
      {
        id: 's1:1',
        type: 'mind_map',
        text: { text: 'Root' },
        mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' },
      },
    ]);
    console.log('seq root:', r.code, r.msg);
    await sleep(1200);
    r = await createNodes(client, whiteboardId, [
      {
        id: 's1:2',
        type: 'mind_map',
        text: { text: 'Docs' },
        mind_map_node: { parent_id: 's1:1', type: 'mind_map_text', z_index: 0, layout_position: 'right' },
      },
    ]);
    console.log('seq child plain:', r.code, r.msg);
  }

  await safeClear(client, whiteboardId);

  // 2) 批量 root + child plain
  {
    const r = await createNodes(client, whiteboardId, [
      {
        id: 'b1:1',
        type: 'mind_map',
        text: { text: 'Root' },
        mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' },
      },
      {
        id: 'b1:2',
        type: 'mind_map',
        text: { text: 'Docs' },
        mind_map_node: { parent_id: 'b1:1', type: 'mind_map_text', z_index: 0, layout_position: 'right' },
      },
    ]);
    console.log('batch child plain:', r.code, r.msg);
  }

  await safeClear(client, whiteboardId);

  // 3) 批量 root + child link minimal
  {
    const r = await createNodes(client, whiteboardId, [
      {
        id: 'b2:1',
        type: 'mind_map',
        text: { text: 'Root' },
        mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' },
      },
      {
        id: 'b2:2',
        type: 'mind_map',
        text: {
          rich_text: {
            paragraphs: [
              {
                paragraph_type: 0,
                elements: [{ element_type: 1, link_element: { herf: TEST_URL, text: 'Docs' } }],
              },
            ],
          },
        },
        mind_map_node: { parent_id: 'b2:1', type: 'mind_map_text', z_index: 0, layout_position: 'right' },
      },
    ]);
    console.log('batch child link:', r.code, r.msg);
  }

  await safeClear(client, whiteboardId);

  // 4) 批量 root + child mention_doc
  {
    const r = await createNodes(client, whiteboardId, [
      {
        id: 'b3:1',
        type: 'mind_map',
        text: { text: 'Root' },
        mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' },
      },
      {
        id: 'b3:2',
        type: 'mind_map',
        text: {
          rich_text: {
            paragraphs: [
              {
                paragraph_type: 0,
                elements: [{ element_type: 3, mention_doc_element: { doc_url: TEST_URL } }],
              },
            ],
          },
        },
        mind_map_node: { parent_id: 'b3:1', type: 'mind_map_text', z_index: 0, layout_position: 'right' },
      },
    ]);
    console.log('batch child mention_doc:', r.code, r.msg);
  }
}

main().catch(console.error);
