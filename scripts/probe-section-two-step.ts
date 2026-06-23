/** 测试 section 与 connector 分步创建 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient, importBoardMermaidDiagram } from '@feishu-md/feishu';

type UnknownRecord = Record<string, unknown>;

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

  await importBoardMermaidDiagram(
    client,
    wb,
    `flowchart TB\n  subgraph sg1 [势力层]\n    A[节点A]\n    B[节点B]\n    A --> B\n  end`,
    0,
  );

  const nodes =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];

  const text = (n: UnknownRecord) => String((n.text as UnknownRecord)?.text ?? '');
  const sA = nodes.find((n) => n.type === 'composite_shape' && text(n) === '节点A')!;
  const sB = nodes.find((n) => n.type === 'composite_shape' && text(n) === '节点B')!;
  const conn = nodes.find((n) => n.type === 'connector')!;

  const bounds = {
    x: Math.min(Number(sA.x), Number(sB.x)) - 16,
    y: Math.min(Number(sA.y), Number(sB.y)) - 44,
    width: 200,
    height: 180,
  };

  const sectionId = 'r1:1';
  const idA = 'r1:2';
  const idB = 'r1:3';

  const step1 = [
    {
      id: sectionId,
      type: 'section',
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      angle: 0,
      z_index: 0,
      section: { title: '势力层' },
      children: [idA, idB],
    },
    {
      id: idA,
      type: 'composite_shape',
      parent_id: sectionId,
      x: Number(sA.x) - bounds.x,
      y: Number(sA.y) - bounds.y,
      width: sA.width,
      height: sA.height,
      angle: 0,
      text: { text: '节点A' },
      composite_shape: { type: 'round_rect' },
      z_index: 1,
    },
    {
      id: idB,
      type: 'composite_shape',
      parent_id: sectionId,
      x: Number(sB.x) - bounds.x,
      y: Number(sB.y) - bounds.y,
      width: sB.width,
      height: sB.height,
      angle: 0,
      text: { text: '节点B' },
      composite_shape: { type: 'round_rect' },
      z_index: 2,
    },
  ];

  const res1 = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: step1 as never },
  });
  console.log('step1 section+shapes', res1.code, res1.msg);

  await new Promise((r) => setTimeout(r, 2500));

  const c = structuredClone(conn.connector) as UnknownRecord;
  const remap = (ep: UnknownRecord | undefined, nid: string) => {
    if (ep) ep.id = nid;
  };
  remap(c.start_object as UnknownRecord, idA);
  remap(c.end_object as UnknownRecord, idB);
  remap((c.start as UnknownRecord)?.attached_object as UnknownRecord, idA);
  remap((c.end as UnknownRecord)?.attached_object as UnknownRecord, idB);

  const connPayload = {
    id: 'r1:c1',
    type: 'connector',
    parent_id: sectionId,
    x: 40,
    y: 60,
    width: 0,
    height: 0,
    angle: 0,
    style: conn.style,
    connector: c,
    z_index: 1,
  };

  const res2 = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: [connPayload] as never },
  });
  console.log('step2 connector alone', res2.code, res2.msg);

  const res3 = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: {
      nodes: [{ ...connPayload, id: 'r1:c2', parent_id: undefined }] as never,
    },
  });
  console.log('step2b connector global', res3.code, res3.msg);
}

main().catch(console.error);
