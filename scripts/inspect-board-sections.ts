/** 对比两个 docx 画板中 section / group 节点结构 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient } from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

async function inspectDoc(docId: string, label: string): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const credentials = await getFeishuCredentials(db);
  if (!credentials) throw new Error('no creds');
  const client = createFeishuClient(credentials);

  const blocks = await client.docx.v1.documentBlock.list({
    path: { document_id: docId },
    params: { page_size: 500 },
  });
  const board = blocks.data?.items?.find((b) => b.block_type === 43);
  const wb = board?.board?.token;
  console.log(`\n=== ${label} (${docId}) whiteboard=${wb} ===`);
  if (!wb) return;

  const nodes = await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } });
  const list = (nodes.data as { nodes?: UnknownRecord[] })?.nodes ?? [];
  const types = new Map<string, number>();
  for (const n of list) {
    types.set(String(n.type), (types.get(String(n.type)) ?? 0) + 1);
  }
  console.log('types:', Object.fromEntries(types));

  for (const n of list.filter((x) => x.type === 'section' || x.type === 'group').slice(0, 3)) {
    console.log(JSON.stringify({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      parent_id: n.parent_id,
      section: n.section,
      children: n.children,
    }, null, 2));
  }

  const section = list.find((x) => x.type === 'section');
  if (section?.id) {
    const children = list.filter((x) => x.parent_id === section.id).slice(0, 3);
    console.log('section children sample:', children.map((c) => ({
      id: c.id,
      type: c.type,
      x: c.x,
      y: c.y,
      parent_id: c.parent_id,
      text: (c.text as UnknownRecord | undefined)?.text,
    })));
    console.log('section abs:', { x: section.x, y: section.y });
  }
}

async function main(): Promise<void> {
  await inspectDoc('RrkJdUHs2oSgkBxK68Mc1EO6nxh', '参考-分区');
  await inspectDoc('CeR5dDdDEoD3TwxfBbtcyGJrn0g', '错误示范');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
