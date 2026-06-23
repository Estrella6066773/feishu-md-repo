import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient, ensureWhiteboardInDocument, listBoardNodeIds } from '@feishu-md/feishu';

const DOC_ID = 'WF2EdWcLeoeelvxIXLhcyjxDnph';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const dataDir = join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo');
  const { db } = createDb({ dbPath: join(dataDir, 'app.db'), runMigrations: false });
  const credentials = await getFeishuCredentials(db);
  if (!credentials) throw new Error('no creds');
  const client = createFeishuClient(credentials);
  const whiteboardId = await ensureWhiteboardInDocument(client, DOC_ID);

  const list = await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: whiteboardId } });
  console.log('existing nodes:', JSON.stringify(list.data?.nodes?.map((n) => ({ id: n.id, type: n.type })), null, 2));

  // batch test only
  const cases = [
    {
      name: 'batch plain no layout_position',
      nodes: [
        { id: 'b1:1', type: 'mind_map', text: { text: 'Root' }, mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' } },
        { id: 'b1:2', type: 'mind_map', text: { text: 'Docs' }, mind_map_node: { parent_id: 'b1:1', type: 'mind_map_text', z_index: 0 } },
      ],
    },
    {
      name: 'batch plain with layout_position',
      nodes: [
        { id: 'b2:1', type: 'mind_map', text: { text: 'Root2' }, mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' } },
        { id: 'b2:2', type: 'mind_map', text: { text: 'Docs' }, mind_map_node: { parent_id: 'b2:1', type: 'mind_map_text', z_index: 0, layout_position: 'right' } },
      ],
    },
    {
      name: 'batch link minimal',
      nodes: [
        { id: 'b3:1', type: 'mind_map', text: { text: 'Root3' }, mind_map_root: { layout: 'left_right', type: 'mind_map_round_rect', line_style: 'round_angle' } },
        {
          id: 'b3:2',
          type: 'mind_map',
          text: { rich_text: { paragraphs: [{ paragraph_type: 0, elements: [{ element_type: 1, link_element: { herf: 'https://feishu.cn/docx/test', text: 'Docs' } }] }] } },
          mind_map_node: { parent_id: 'b3:1', type: 'mind_map_text', z_index: 0 },
        },
      ],
    },
  ];

  for (const testCase of cases) {
    // delete all nodes first - list ids
    const ids = await listBoardNodeIds(client, whiteboardId);
    if (ids.length > 0) {
      await (client as unknown as { request: (p: unknown) => Promise<unknown> }).request({
        method: 'DELETE',
        url: `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes/batch_delete`,
        data: { ids },
      });
      await sleep(1000);
    }

    const response = await client.board.v1.whiteboardNode.create({
      path: { whiteboard_id: whiteboardId },
      data: { nodes: testCase.nodes as never },
    });
    console.log(testCase.name, response.code, response.msg);
    await sleep(500);
  }
}

main().catch(console.error);
