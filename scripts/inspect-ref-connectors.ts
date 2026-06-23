import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient } from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

async function main(): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const client = createFeishuClient((await getFeishuCredentials(db))!);
  const wb = (await client.docx.v1.documentBlock.list({
    path: { document_id: 'RrkJdUHs2oSgkBxK68Mc1EO6nxh' },
    params: { page_size: 500 },
  })).data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  const nodes =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];

  const sections = new Map(nodes.filter((n) => n.type === 'section').map((s) => [String(s.id), s]));
  const shapeParent = (id: string) => {
    const shape = nodes.find((n) => n.id === id);
    return shape?.parent_id ? String(shape.parent_id) : null;
  };

  const global = nodes.filter((n) => n.type === 'connector' && !n.parent_id);
  const inSection = nodes.filter((n) => n.type === 'connector' && n.parent_id);
  console.log('global connectors', global.length);
  console.log('section connectors', inSection.length);

  for (const conn of global.slice(0, 5)) {
    const c = conn.connector as UnknownRecord;
    const startId = String((c.start_object as UnknownRecord)?.id ?? '');
    const endId = String((c.end_object as UnknownRecord)?.id ?? '');
    console.log({
      id: conn.id,
      x: conn.x,
      y: conn.y,
      startParent: shapeParent(startId),
      endParent: shapeParent(endId),
      startId,
      endId,
    });
  }

  for (const conn of inSection) {
    const c = conn.connector as UnknownRecord;
    const startId = String((c.start_object as UnknownRecord)?.id ?? '');
    const endId = String((c.end_object as UnknownRecord)?.id ?? '');
    const sp = shapeParent(startId);
    const ep = shapeParent(endId);
    if (sp && ep && sp !== ep) {
      console.log('cross-section in-section conn', {
        id: conn.id,
        parent_id: conn.parent_id,
        x: conn.x,
        y: conn.y,
        sp,
        ep,
      });
    }
  }
}

main().catch(console.error);
