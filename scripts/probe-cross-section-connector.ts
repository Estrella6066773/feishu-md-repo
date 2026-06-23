/** 探测：两个 section 内形状之间的全局 connector */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import {
  applyMermaidSubgraphSections,
  clearBoardNodes,
  createFeishuClient,
  importBoardMermaidDiagram,
} from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

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
  const client = createFeishuClient((await getFeishuCredentials(db))!);
  const wb = (await client.docx.v1.documentBlock.list({
    path: { document_id: 'CeR5dDdDEoD3TwxfBbtcyGJrn0g' },
    params: { page_size: 500 },
  })).data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  await clearBoardNodes(client, wb);
  await importBoardMermaidDiagram(client, wb, MERMAID, 0);
  const imported =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];
  const crossConn = imported.find((n) => {
    if (n.type !== 'connector') return false;
    const c = n.connector as UnknownRecord;
    const startId = String((c.start_object as UnknownRecord)?.id ?? '');
    const endId = String((c.end_object as UnknownRecord)?.id ?? '');
    const text = (id: string) =>
      String(
        imported.find((s) => s.id === id && s.type === 'composite_shape')?.text &&
          (imported.find((s) => s.id === id)!.text as UnknownRecord).text,
      );
    return text(startId) === '节点B' && text(endId) === '节点C';
  });
  console.log('imported cross conn', crossConn?.id, crossConn?.connector);

  await applyMermaidSubgraphSections(client, wb, MERMAID);

  const after =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];
  const text = (n: UnknownRecord) => String((n.text as UnknownRecord)?.text ?? '');
  const shapeB = after.find((n) => n.type === 'composite_shape' && text(n) === '节点B');
  const shapeC = after.find((n) => n.type === 'composite_shape' && text(n) === '节点C');
  console.log('shapeB', shapeB?.id, 'parent', shapeB?.parent_id);
  console.log('shapeC', shapeC?.id, 'parent', shapeC?.parent_id);
  console.log(
    'connectors',
    after.filter((n) => n.type === 'connector').length,
    after.filter((n) => n.type === 'connector').map((n) => n.parent_id),
  );

  if (!crossConn || !shapeB?.id || !shapeC?.id) return;

  const c = structuredClone(crossConn.connector) as UnknownRecord;
  const attach = (ep: UnknownRecord | undefined, nid: string) => {
    if (!ep) return;
    ep.id = nid;
  };
  attach(c.start_object as UnknownRecord, String(shapeB.id));
  attach(c.end_object as UnknownRecord, String(shapeC.id));
  attach((c.start as UnknownRecord)?.attached_object as UnknownRecord, String(shapeB.id));
  attach((c.end as UnknownRecord)?.attached_object as UnknownRecord, String(shapeC.id));

  const abs = (shape: UnknownRecord) => {
    const parent = after.find((n) => n.id === shape.parent_id);
    return {
      x: Number(parent?.x ?? 0) + Number(shape.x ?? 0),
      y: Number(parent?.y ?? 0) + Number(shape.y ?? 0),
      w: Number(shape.width ?? 0),
      h: Number(shape.height ?? 0),
    };
  };
  const b = abs(shapeB);
  const c2 = abs(shapeC);
  const gx = Math.min(b.x + b.w / 2, c2.x + c2.w / 2);
  const gy = Math.min(b.y + b.h / 2, c2.y + c2.h / 2);
  const width = Math.abs(c2.x + c2.w / 2 - (b.x + b.w / 2));

  const variants = [
    {
      name: 'ref-like',
      c: {
        ...c,
        shape: 'polyline',
        start: {
          arrow_style: 'none',
          attached_object: { id: String(shapeB.id), snap_to: 'right', position: { x: 1, y: 0.5 } },
        },
        end: {
          arrow_style: 'line_arrow',
          attached_object: { id: String(shapeC.id), snap_to: 'left', position: { x: 0, y: 0.5 } },
        },
        start_object: { id: String(shapeB.id), snap_to: 'right', position: { x: 1, y: 0.5 } },
        end_object: { id: String(shapeC.id), snap_to: 'left', position: { x: 0, y: 0.5 } },
      },
      x: gx,
      y: gy,
      width,
    },
    {
      name: 'import-like',
      c,
      x: gx,
      y: gy,
      width: 0,
    },
  ];

  for (const variant of variants) {
    const payload = {
      id: `probe:${variant.name}`,
      type: 'connector',
      x: variant.x,
      y: variant.y,
      width: variant.width,
      height: 0,
      angle: 0,
      style: crossConn.style,
      connector: variant.c,
      z_index: 5,
    };
    const res = await client.board.v1.whiteboardNode.create({
      path: { whiteboard_id: wb },
      data: { nodes: [payload] as never },
    });
    console.log('manual cross recreate', variant.name, res.code, res.msg);
  }
}

main().catch(console.error);
