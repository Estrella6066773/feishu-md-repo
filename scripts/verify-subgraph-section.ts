/** 在画板上验证 applyMermaidSubgraphSections */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import {
  applyMermaidSubgraphSections,
  createFeishuClient,
  importBoardMermaidDiagram,
} from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

const TEST_DOC = 'CeR5dDdDEoD3TwxfBbtcyGJrn0g';

// 与错误示范文档相近的 subgraph 流程图（可按实际源文件替换）
const MERMAID = `flowchart TB
  subgraph sg1 [势力层]
    A[节点A]
    B[节点B]
    A --> B
  end
  subgraph sg2 [地图图层]
    C[节点C]
    D[节点D]
    C --> D
  end
  B --> C
`;

async function main(): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const credentials = await getFeishuCredentials(db);
  if (!credentials) throw new Error('no creds');
  const client = createFeishuClient(credentials);

  const blocks = await client.docx.v1.documentBlock.list({
    path: { document_id: TEST_DOC },
    params: { page_size: 500 },
  });
  const wb = blocks.data?.items?.find((b) => b.block_type === 43)?.board?.token;
  if (!wb) throw new Error('no whiteboard');

  console.log('whiteboard', wb);
  await importBoardMermaidDiagram(client, wb, MERMAID, 0);

  const before = await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } });
  const beforeNodes = ((before.data as { nodes?: UnknownRecord[] })?.nodes ?? []) as UnknownRecord[];
  const types = new Map<string, number>();
  for (const n of beforeNodes) {
    types.set(String(n.type), (types.get(String(n.type)) ?? 0) + 1);
  }
  console.log('after import types', Object.fromEntries(types));
  console.log(
    'groups',
    beforeNodes
      .filter((n) => n.type === 'group')
      .map((n) => ({ id: n.id, title: (n.section as UnknownRecord)?.title, children: n.children })),
  );

  try {
    await applyMermaidSubgraphSections(client, wb, MERMAID);
    console.log('applyMermaidSubgraphSections OK');
  } catch (error) {
    console.error('applyMermaidSubgraphSections FAILED', error);
  }

  const after = await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } });
  const afterNodes = ((after.data as { nodes?: UnknownRecord[] })?.nodes ?? []) as UnknownRecord[];
  const types2 = new Map<string, number>();
  for (const n of afterNodes) {
    types2.set(String(n.type), (types2.get(String(n.type)) ?? 0) + 1);
  }
  console.log('after section types', Object.fromEntries(types2));
  console.log(
    'sections',
    afterNodes
      .filter((n) => n.type === 'section')
      .map((n) => ({
        title: (n.section as UnknownRecord)?.title,
        children: (n.children as string[] | undefined)?.length,
      })),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
