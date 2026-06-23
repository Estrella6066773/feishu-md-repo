/** 测试分区内 connector 的相对坐标规则 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient, importBoardMermaidDiagram } from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

const MERMAID = `flowchart TB
  subgraph sg1 [势力层]
    A[节点A]
    B[节点B]
    A --> B
  end
`;

async function tryCreate(
  client: ReturnType<typeof createFeishuClient>,
  wb: string,
  name: string,
  nodes: UnknownRecord[],
): Promise<void> {
  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: nodes as never },
  });
  console.log(name, res.code === 0 ? 'OK' : `FAIL ${res.code} ${res.msg}`);
}

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
      nodes?: UnknownRecord[];
    })?.nodes ?? [];

  const shapes = nodes.filter((n) => n.type === 'composite_shape');
  const conn = nodes.find((n) => n.type === 'connector')!;
  const s0 = shapes[0]!;
  const s1 = shapes[1]!;

  const bounds = {
    x: Math.min(Number(s0.x), Number(s1.x)) - 16,
    y: Math.min(Number(s0.y), Number(s1.y)) - 44,
    width: 300,
    height: 200,
  };

  const sectionId = 'q1:1';
  const idA = 'q1:2';
  const idB = 'q1:3';

  const shapePayloads = [
    {
      id: idA,
      type: 'composite_shape',
      parent_id: sectionId,
      x: Number(s0.x) - bounds.x,
      y: Number(s0.y) - bounds.y,
      width: s0.width,
      height: s0.height,
      angle: 0,
      text: { text: '节点A' },
      composite_shape: { type: 'round_rect' },
      z_index: 1,
    },
    {
      id: idB,
      type: 'composite_shape',
      parent_id: sectionId,
      x: Number(s1.x) - bounds.x,
      y: Number(s1.y) - bounds.y,
      width: s1.width,
      height: s1.height,
      angle: 0,
      text: { text: '节点B' },
      composite_shape: { type: 'round_rect' },
      z_index: 2,
    },
  ];

  const baseSection = {
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

  function remapConn(id: string, x: number, y: number): UnknownRecord {
    const c = structuredClone(conn.connector) as UnknownRecord;
    const remap = (ep: UnknownRecord | undefined, newId: string) => {
      if (!ep) return;
      ep.id = newId;
    };
    remap(c.start_object as UnknownRecord, idA);
    remap(c.end_object as UnknownRecord, idB);
    remap((c.start as UnknownRecord)?.attached_object as UnknownRecord, idA);
    remap((c.end as UnknownRecord)?.attached_object as UnknownRecord, idB);
    return {
      id,
      type: 'connector',
      parent_id: sectionId,
      x,
      y,
      width: 0,
      height: 0,
      angle: 0,
      style: {
        border_width: 'narrow',
        border_color: '#000000',
        border_opacity: 100,
        border_style: 'solid',
        theme_border_color_code: -1,
      },
      connector: c,
      z_index: 1,
    };
  }

  const cases = [
    { name: 'conn relative 0,0', conn: remapConn('q1:c1', 0, 0) },
    {
      name: 'conn relative from shape mid',
      conn: remapConn(
        'q1:c2',
        (Number(shapePayloads[0]!.x) + Number(shapePayloads[1]!.x)) / 2,
        Number(shapePayloads[0]!.y) + Number(shapePayloads[0]!.height) / 2,
      ),
    },
    {
      name: 'conn no parent global',
      conn: { ...remapConn('q1:c3', Number(conn.x), Number(conn.y)), parent_id: undefined },
    },
    {
      name: 'conn copy imported global xy',
      conn: remapConn('q1:c4', Number(conn.x) - bounds.x, Number(conn.y) - bounds.y),
    },
  ];

  for (const testCase of cases) {
    const childIds = [...shapePayloads.map((s) => String(s.id)), String(testCase.conn.id)];
    await tryCreate(client, wb, testCase.name, [
      { ...baseSection, children: childIds },
      ...shapePayloads,
      testCase.conn,
    ]);
  }
}

main().catch(console.error);
