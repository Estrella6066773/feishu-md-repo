/** 探测 section 批量 create 所需字段，对照参考画板 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient } from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

const REF_DOC = 'RrkJdUHs2oSgkBxK68Mc1EO6nxh';
const WRONG_DOC = 'CeR5dDdDEoD3TwxfBbtcyGJrn0g';

async function getWhiteboardId(
  client: ReturnType<typeof createFeishuClient>,
  docId: string,
): Promise<string | null> {
  const blocks = await client.docx.v1.documentBlock.list({
    path: { document_id: docId },
    params: { page_size: 500 },
  });
  return blocks.data?.items?.find((b) => b.block_type === 43)?.board?.token ?? null;
}

async function listNodes(client: ReturnType<typeof createFeishuClient>, wb: string) {
  const res = await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } });
  return ((res.data as { nodes?: UnknownRecord[] })?.nodes ?? []) as UnknownRecord[];
}

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
  console.log(name, '->', res.code, res.msg);
  if (res.code !== 0) {
    console.log('  error detail:', JSON.stringify((res as UnknownRecord).error ?? res, null, 2).slice(0, 800));
  }
}

async function main(): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const credentials = await getFeishuCredentials(db);
  if (!credentials) throw new Error('no creds');
  const client = createFeishuClient(credentials);

  const refWb = await getWhiteboardId(client, REF_DOC);
  const wrongWb = await getWhiteboardId(client, WRONG_DOC);
  if (!refWb || !wrongWb) throw new Error('missing whiteboard');

  const refNodes = await listNodes(client, refWb);
  const section = refNodes.find((n) => n.type === 'section');
  const child = refNodes.find((n) => n.id === (section?.children as string[] | undefined)?.[0]);
  const childShape = refNodes.find((n) => n.type === 'composite_shape' && n.parent_id === section?.id);
  const childConn = refNodes.find((n) => n.type === 'connector' && n.parent_id === section?.id);

  console.log('REF section keys:', section ? Object.keys(section) : null);
  console.log('REF section sample:', JSON.stringify(section, null, 2).slice(0, 1200));
  console.log('REF shape sample:', JSON.stringify(childShape, null, 2).slice(0, 800));
  console.log('REF connector sample:', JSON.stringify(childConn, null, 2).slice(0, 800));

  const wrongNodes = await listNodes(client, wrongWb);
  const shapes = wrongNodes.filter((n) => n.type === 'composite_shape' && !n.parent_id).slice(0, 2);
  console.log('\nWRONG shapes:', shapes.map((s) => ({ id: s.id, text: (s.text as UnknownRecord)?.text, x: s.x, y: s.y })));

  if (shapes.length < 2) {
    console.log('not enough shapes on wrong board');
    return;
  }

  const s0 = shapes[0]!;
  const s1 = shapes[1]!;
  const bounds = {
    x: Math.min(Number(s0.x), Number(s1.x)) - 16,
    y: Math.min(Number(s0.y), Number(s1.y)) - 44,
    width: 300,
    height: 200,
  };

  const shapePayload = (id: string, shape: UnknownRecord, sectionId: string) => ({
    id,
    type: 'composite_shape',
    parent_id: sectionId,
    x: Number(shape.x) - bounds.x,
    y: Number(shape.y) - bounds.y,
    width: shape.width,
    height: shape.height,
    angle: 0,
    text: { text: String((shape.text as UnknownRecord)?.text ?? 'node').slice(0, 100) },
    composite_shape: { type: 'round_rect' },
    z_index: 1,
  });

  const cases: Array<{ name: string; nodes: UnknownRecord[] }> = [
    {
      name: 'section only minimal',
      nodes: [
        {
          id: 't1:1',
          type: 'section',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          angle: 0,
          z_index: 0,
          section: { title: '测试分区' },
        },
      ],
    },
    {
      name: 'section + shapes children first, no children array',
      nodes: [
        shapePayload('t2:2', s0, 't2:1'),
        shapePayload('t2:3', s1, 't2:1'),
        {
          id: 't2:1',
          type: 'section',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          angle: 0,
          z_index: 0,
          section: { title: '测试分区' },
        },
      ],
    },
    {
      name: 'section first + shapes with children array',
      nodes: [
        {
          id: 't3:1',
          type: 'section',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          angle: 0,
          z_index: 0,
          section: { title: '测试分区' },
          children: ['t3:2', 't3:3'],
        },
        shapePayload('t3:2', s0, 't3:1'),
        shapePayload('t3:3', s1, 't3:1'),
      ],
    },
    {
      name: 'section with ref style',
      nodes: [
        {
          id: 't4:1',
          type: 'section',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          angle: 0,
          z_index: 0,
          style: section?.style,
          section: { title: '测试分区' },
          children: ['t4:2', 't4:3'],
        },
        shapePayload('t4:2', s0, 't4:1'),
        shapePayload('t4:3', s1, 't4:1'),
      ],
    },
    {
      name: 'shapes copy composite_shape from import',
      nodes: [
        {
          id: 't5:1',
          type: 'section',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          angle: 0,
          z_index: 0,
          section: { title: '测试分区' },
        },
        {
          id: 't5:2',
          type: 'composite_shape',
          parent_id: 't5:1',
          x: Number(s0.x) - bounds.x,
          y: Number(s0.y) - bounds.y,
          width: s0.width,
          height: s0.height,
          angle: s0.angle ?? 0,
          text: s0.text,
          composite_shape: s0.composite_shape,
          z_index: 1,
        },
      ],
    },
  ];

  console.log('\n--- probes on wrong doc whiteboard ---');
  for (const testCase of cases) {
    const ids = testCase.nodes.map((n) => String(n.id));
    await client.request({
      method: 'DELETE',
      url: `/open-apis/board/v1/whiteboards/${encodeURIComponent(wrongWb)}/nodes/batch_delete`,
      data: { ids },
    }).catch(() => undefined);
    await tryCreate(client, wrongWb, testCase.name, testCase.nodes);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
