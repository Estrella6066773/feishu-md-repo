/** 探测：sg1 batch 内含跨区连线（终点仍为全局形状） */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { clearBoardNodes, createFeishuClient, importBoardMermaidDiagram } from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

const MERMAID = `flowchart TB
  subgraph sg1 [势力层]
    A[节点A]
    B[节点B]
    A --> B
  end
  subgraph sg2 [地图图层]
    C[节点C]
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
  const nodes = ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as any)?.nodes ?? [];
  const text = (n: any) => String(n.text?.text ?? '');
  const sA = nodes.find((n: any) => text(n) === '节点A')!;
  const sB = nodes.find((n: any) => text(n) === '节点B')!;
  const sC = nodes.find((n: any) => text(n) === '节点C')!;
  const cross = nodes.find((n: any) => {
    if (n.type !== 'connector') return false;
    const c = n.connector;
    return String(c?.start_object?.id) === String(sB.id);
  })!;

  const bounds = {
    x: Math.min(Number(sA.x), Number(sB.x)) - 16,
    y: Math.min(Number(sA.y), Number(sB.y)) - 44,
    width: 260,
    height: 200,
  };
  const rel = (s: typeof sA) => ({ x: Number(s.x) - bounds.x, y: Number(s.y) - bounds.y });
  const sectionId = 'v1:1';
  const idA = 'v1:2';
  const idB = 'v1:3';
  const idAB = 'v1:c1';
  const idBC = 'v1:c2';

  const cAB = structuredClone(cross.connector);
  // internal A->B placeholder - find internal from import
  const internal = nodes.find((n: any) => n.type === 'connector' && n.id !== cross.id)!;
  const cInt = structuredClone(internal.connector);
  const mapEp = (c: any, start: string, end: string) => {
    c.start_object = { id: start, snap_to: 'right', position: { x: 1, y: 0.5 } };
    c.end_object = { id: end, snap_to: 'left', position: { x: 0, y: 0.5 } };
    c.start = { arrow_style: 'none', attached_object: { ...c.start_object } };
    c.end = { arrow_style: 'triangle_arrow', attached_object: { ...c.end_object } };
  };
  mapEp(cInt, idA, idB);
  mapEp(cAB, idB, String(sC.id));

  const rA = rel(sA);
  const rB = rel(sB);
  const batch = [
    { id: idA, type: 'composite_shape', parent_id: sectionId, ...rA, width: sA.width, height: sA.height, angle: 0, text: { text: '节点A' }, composite_shape: { type: 'round_rect' }, z_index: 1 },
    { id: idB, type: 'composite_shape', parent_id: sectionId, ...rB, width: sB.width, height: sB.height, angle: 0, text: { text: '节点B' }, composite_shape: { type: 'round_rect' }, z_index: 2 },
    { id: idAB, type: 'connector', parent_id: sectionId, x: Math.min(rA.x, rB.x) + 20, y: rA.y + Number(sA.height) / 2, width: 0, height: 0, angle: 0, style: internal.style, connector: cInt, z_index: 3 },
    { id: idBC, type: 'connector', parent_id: sectionId, x: rB.x + Number(sB.width) / 2, y: rB.y + Number(sB.height), width: 0, height: 0, angle: 0, style: cross.style, connector: cAB, z_index: 4 },
    { id: sectionId, type: 'section', x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, angle: 0, z_index: 0, section: { title: '势力层' } },
  ];

  await clearBoardNodes(client, wb);
  await importBoardMermaidDiagram(client, wb, MERMAID, 0);
  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: batch as never },
  });
  console.log('sg1 batch with cross to global C', res.code, res.msg);
}

main().catch(console.error);
