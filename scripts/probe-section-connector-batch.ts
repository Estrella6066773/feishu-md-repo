import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { clearBoardNodes, createFeishuClient, importBoardMermaidDiagram } from '@feishu-md/feishu';

const DOC = 'CeR5dDdDEoD3TwxfBbtcyGJrn0g';
const MERMAID = `flowchart TB\n  subgraph sg1 [势力层]\n    A[节点A]\n    B[节点B]\n    A --> B\n  end`;

async function main(): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const client = createFeishuClient((await getFeishuCredentials(db))!);
  const wb = (await client.docx.v1.documentBlock.list({
    path: { document_id: DOC },
    params: { page_size: 500 },
  })).data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  await importBoardMermaidDiagram(client, wb, MERMAID, 0);
  const nodes = ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as any)?.nodes ?? [];
  const text = (n: any) => String(n.text?.text ?? '');
  const sA = nodes.find((n: any) => n.type === 'composite_shape' && text(n) === '节点A')!;
  const sB = nodes.find((n: any) => n.type === 'composite_shape' && text(n) === '节点B')!;
  const conn = nodes.find((n: any) => n.type === 'connector')!;
  const title = nodes.find((n: any) => n.type === 'composite_shape' && text(n) === '势力层');

  await clearBoardNodes(client, wb);

  const bounds = {
    x: Math.min(Number(sA.x), Number(sB.x)) - 16,
    y: Math.min(Number(sA.y), Number(sB.y)) - 44,
    width: 260,
    height: 200,
  };
  const rel = (shape: typeof sA) => ({
    x: Number(shape.x) - bounds.x,
    y: Number(shape.y) - bounds.y,
  });
  const rA = rel(sA);
  const rB = rel(sB);

  const sectionId = 'u1:1';
  const idA = 'u1:2';
  const idB = 'u1:3';
  const idC = 'u1:c1';

  const shapeA = {
    id: idA,
    type: 'composite_shape',
    parent_id: sectionId,
    ...rA,
    width: sA.width,
    height: sA.height,
    angle: 0,
    text: { text: '节点A' },
    composite_shape: { type: 'round_rect' },
    z_index: 1,
  };
  const shapeB = {
    id: idB,
    type: 'composite_shape',
    parent_id: sectionId,
    ...rB,
    width: sB.width,
    height: sB.height,
    angle: 0,
    text: { text: '节点B' },
    composite_shape: { type: 'round_rect' },
    z_index: 2,
  };

  const c = structuredClone(conn.connector);
  c.start_object = { id: idA, snap_to: 'right', position: { x: 1, y: 0.5 } };
  c.end_object = { id: idB, snap_to: 'left', position: { x: 0, y: 0.5 } };
  c.start = { arrow_style: 'none', attached_object: { ...c.start_object } };
  c.end = { arrow_style: 'triangle_arrow', attached_object: { ...c.end_object } };

  const connector = {
    id: idC,
    type: 'connector',
    parent_id: sectionId,
    x: Math.min(rA.x, rB.x) + 20,
    y: rA.y + Number(sA.height) / 2,
    width: 0,
    height: 0,
    angle: 0,
    style: conn.style,
    connector: c,
    z_index: 3,
  };

  const section = {
    id: sectionId,
    type: 'section',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    z_index: 0,
    section: { title: '势力层' },
  };

  const cases: Array<{ name: string; nodes: unknown[] }> = [
    { name: 'shapes+section only', nodes: [shapeA, shapeB, section] },
    { name: 'shapes+conn+section', nodes: [shapeA, shapeB, connector, section] },
    { name: 'conn+shapes+section', nodes: [connector, shapeA, shapeB, section] },
  ];

  for (const testCase of cases) {
    await clearBoardNodes(client, wb);
    const res = await client.board.v1.whiteboardNode.create({
      path: { whiteboard_id: wb },
      data: { nodes: testCase.nodes as never },
    });
    console.log(testCase.name, res.code, res.msg);
  }
}

main().catch(console.error);
