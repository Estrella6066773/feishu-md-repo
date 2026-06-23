import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { clearBoardNodes, createFeishuClient, importBoardMermaidDiagram } from '@feishu-md/feishu';

const MERMAID = `flowchart TB
  subgraph sg1 [势力层]
    A[节点A]
    B[节点B]
    A --> B
  end
`;

async function main(): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const client = createFeishuClient((await getFeishuCredentials(db))!);
  const wb = (await client.docx.v1.documentBlock.list({
    path: { document_id: 'CeR5dDdDEoD3TwxfBbtcyGJrn0g' },
    params: { page_size: 500 },
  })).data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  await importBoardMermaidDiagram(client, wb, MERMAID, 0);
  await clearBoardNodes(client, wb);

  const batch = [
    {
      id: 'e1:2',
      type: 'composite_shape',
      parent_id: 'e1:1',
      x: 16,
      y: 44,
      width: 73,
      height: 52,
      angle: 0,
      text: { text: '节点A' },
      composite_shape: { type: 'round_rect' },
      z_index: 1,
    },
    {
      id: 'e1:3',
      type: 'composite_shape',
      parent_id: 'e1:1',
      x: 174,
      y: 44,
      width: 73,
      height: 52,
      angle: 0,
      text: { text: '节点B' },
      composite_shape: { type: 'round_rect' },
      z_index: 2,
    },
    {
      id: 'e1:1',
      type: 'section',
      x: 34.5,
      y: 4,
      width: 248,
      height: 100,
      angle: 0,
      z_index: 0,
      section: { title: '势力层' },
    },
  ];

  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: batch as never },
  });
  console.log('empty board create', res.code, res.msg);
}

main().catch(console.error);
