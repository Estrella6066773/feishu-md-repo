/** 二分定位 section batch create 中导致 2890002 的字段 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient, importBoardMermaidDiagram, parseMermaidGraph } from '@feishu-md/feishu';

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

const WRONG_DOC = 'CeR5dDdDEoD3TwxfBbtcyGJrn0g';

function nodeText(node: UnknownRecord): string {
  const text = (node.text as UnknownRecord | undefined)?.text;
  if (typeof text === 'string') return text.trim();
  const rich = (node.text as UnknownRecord | undefined)?.rich_text as UnknownRecord | undefined;
  const p = (rich?.paragraphs as UnknownRecord[] | undefined)?.[0];
  const el = (p?.elements as UnknownRecord[] | undefined)?.[0];
  const t = (el?.text_run as UnknownRecord | undefined)?.content;
  return typeof t === 'string' ? t.trim() : '';
}

async function tryBatch(
  client: ReturnType<typeof createFeishuClient>,
  wb: string,
  name: string,
  nodes: UnknownRecord[],
): Promise<boolean> {
  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: nodes as never },
  });
  const ok = res.code === 0;
  console.log(name, ok ? 'OK' : `FAIL ${res.code} ${res.msg}`);
  return ok;
}

async function main(): Promise<void> {
  const { db } = createDb({
    dbPath: join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db'),
    runMigrations: false,
  });
  const client = createFeishuClient((await getFeishuCredentials(db))!);

  const blocks = await client.docx.v1.documentBlock.list({
    path: { document_id: WRONG_DOC },
    params: { page_size: 500 },
  });
  const wb = blocks.data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  await importBoardMermaidDiagram(client, wb, MERMAID, 0);
  const list = await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } });
  const nodes = ((list.data as { nodes?: UnknownRecord[] })?.nodes ?? []) as UnknownRecord[];

  const parsed = parseMermaidGraph(MERMAID);
  const sg = parsed.subgraphs.find((s) => s.title === '势力层')!;
  const labels = sg.memberIds.map((id) => parsed.nodeLabels.get(id)!);

  const shapes = labels
    .map((label) => nodes.find((n) => n.type === 'composite_shape' && nodeText(n) === label))
    .filter(Boolean) as UnknownRecord[];

  const shapeIds = new Set(shapes.map((s) => String(s.id)));
  const connectors = nodes.filter((n) => {
    if (n.type !== 'connector') return false;
    const c = n.connector as UnknownRecord;
    const startId = String((c.start_object as UnknownRecord)?.id ?? '');
    const endId = String((c.end_object as UnknownRecord)?.id ?? '');
    return shapeIds.has(startId) && shapeIds.has(endId);
  });

  console.log('shapes', shapes.map((s) => ({ id: s.id, text: nodeText(s), x: s.x, y: s.y })));
  console.log('internal connectors', connectors.length);

  const xs = shapes.map((s) => Number(s.x));
  const ys = shapes.map((s) => Number(s.y));
  const bounds = {
    x: Math.min(...xs) - 16,
    y: Math.min(...ys) - 44,
    width: 300,
    height: 200,
  };

  const sectionId = 'p1:1';
  const shapePayloads = shapes.map((shape, i) => ({
    id: `p1:${i + 2}`,
    type: 'composite_shape',
    parent_id: sectionId,
    x: Number(shape.x) - bounds.x,
    y: Number(shape.y) - bounds.y,
    width: shape.width,
    height: shape.height,
    angle: 0,
    text: { text: nodeText(shape) },
    composite_shape: { type: 'round_rect' },
    z_index: i + 1,
  }));

  const sectionPayload = {
    id: sectionId,
    type: 'section',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    z_index: 0,
    section: { title: '势力层' },
    children: [...shapePayloads.map((s) => s.id)],
  };

  await tryBatch(client, wb, 'section + shapes', [sectionPayload, ...shapePayloads]);

  if (connectors[0]) {
    const conn = connectors[0];
    const idMap = new Map<string, string>();
    shapes.forEach((s, i) => idMap.set(String(s.id), `p1:${i + 2}`));

    const minimalConn = {
      id: 'p1:c1',
      type: 'connector',
      parent_id: sectionId,
      x: Number(conn.x) - bounds.x,
      y: Number(conn.y) - bounds.y,
      width: conn.width ?? 0,
      height: conn.height ?? 0,
      angle: 0,
      style: {
        border_width: 'narrow',
        border_color: '#000000',
        border_opacity: 100,
        border_style: 'solid',
        theme_border_color_code: -1,
      },
      connector: {
        shape: 'straight',
        specified_coordinate: true,
        start: {
          arrow_style: 'none',
          attached_object: {
            id: idMap.get(String((conn.connector as UnknownRecord).start_object as UnknownRecord)?.id ?? ''),
            snap_to: 'right',
            position: { x: 1, y: 0.5 },
          },
        },
        end: {
          arrow_style: 'triangle_arrow',
          attached_object: {
            id: idMap.get(String((conn.connector as UnknownRecord).end_object as UnknownRecord)?.id ?? ''),
            snap_to: 'left',
            position: { x: 0, y: 0.5 },
          },
        },
      },
      z_index: 1,
    };

    await tryBatch(client, wb, 'section + shapes + minimal connector', [
      { ...sectionPayload, children: [...sectionPayload.children, 'p1:c1'] },
      ...shapePayloads,
      minimalConn,
    ]);

    const fullConn = {
      id: 'p1:c2',
      type: 'connector',
      parent_id: sectionId,
      x: Number(conn.x) - bounds.x,
      y: Number(conn.y) - bounds.y,
      width: conn.width,
      height: conn.height,
      angle: conn.angle ?? 0,
      style: conn.style,
      connector: conn.connector,
      z_index: 1,
    };
    // remap endpoints in fullConn
    const c = fullConn.connector as UnknownRecord;
    for (const key of ['start_object', 'end_object']) {
      const ep = c[key] as UnknownRecord;
      if (ep?.id) ep.id = idMap.get(String(ep.id)) ?? ep.id;
    }
    const start = c.start as UnknownRecord;
    const end = c.end as UnknownRecord;
    if ((start?.attached_object as UnknownRecord)?.id) {
      (start.attached_object as UnknownRecord).id =
        idMap.get(String((start.attached_object as UnknownRecord).id)) ?? (start.attached_object as UnknownRecord).id;
    }
    if ((end?.attached_object as UnknownRecord)?.id) {
      (end.attached_object as UnknownRecord).id =
        idMap.get(String((end.attached_object as UnknownRecord).id)) ?? (end.attached_object as UnknownRecord).id;
    }

    await tryBatch(client, wb, 'section + shapes + full imported connector', [
      { ...sectionPayload, children: [...sectionPayload.children, 'p1:c2'] },
      ...shapePayloads,
      fullConn,
    ]);
  }
}

main().catch(console.error);
