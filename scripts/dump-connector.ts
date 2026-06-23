import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient, importBoardMermaidDiagram } from '@feishu-md/feishu';

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
  const nodes =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: Record<string, unknown>[];
    })?.nodes ?? [];
  const conn = nodes.find((n) => n.type === 'connector');
  console.log(JSON.stringify(conn, null, 2));
}

main().catch(console.error);
