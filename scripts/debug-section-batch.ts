import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import {
  createFeishuClient,
  importBoardMermaidDiagram,
  parseMermaidGraph,
} from '@feishu-md/feishu';

const MERMAID = `flowchart TB
  subgraph sg1 [势力层]
    A[节点A]
    B[节点B]
    A --> B
  end
`;

type UnknownRecord = Record<string, unknown>;

function nodeText(node: UnknownRecord): string {
  const plain = (node.text as UnknownRecord | undefined)?.text;
  if (typeof plain === 'string' && plain.trim()) return plain.trim();
  return '';
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

  console.log(
    'shapes',
    nodes
      .filter((n) => n.type === 'composite_shape')
      .map((n) => ({ id: n.id, text: nodeText(n), x: n.x, y: n.y, w: n.width, h: n.height })),
  );

  const parsed = parseMermaidGraph(MERMAID);
  console.log('subgraphs', parsed.subgraphs);

  const sg = parsed.subgraphs[0]!;
  const labels = sg.memberIds.map((id) => parsed.nodeLabels.get(id)!);
  const memberShapes = labels
    .map((label) =>
      nodes.find(
        (n) => n.type === 'composite_shape' && !n.parent_id && nodeText(n) === label,
      ),
    )
    .filter(Boolean) as UnknownRecord[];

  console.log('memberShapes count', memberShapes.length, labels);

  const xs = memberShapes.map((s) => Number(s.x));
  const ys = memberShapes.map((s) => Number(s.y));
  const bounds = {
    x: Math.min(...xs) - 16,
    y: Math.min(...ys) - 44,
    width: Math.max(...memberShapes.map((s, i) => xs[i]! + Number(s.width))) - Math.min(...xs) + 16,
    height: Math.max(...memberShapes.map((s, i) => ys[i]! + Number(s.height))) - Math.min(...ys) + 44,
  };
  console.log('bounds', bounds);

  const batch = [
    {
      id: 'dbg:1',
      type: 'section',
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      angle: 0,
      z_index: 0,
      section: { title: sg.title },
      children: ['dbg:2', 'dbg:3'],
    },
    ...memberShapes.map((shape, index) => ({
      id: `dbg:${index + 2}`,
      type: 'composite_shape',
      parent_id: 'dbg:1',
      x: Number(shape.x) - bounds.x,
      y: Number(shape.y) - bounds.y,
      width: shape.width,
      height: shape.height,
      angle: 0,
      text: { text: nodeText(shape) },
      composite_shape: { type: 'round_rect' },
      z_index: index + 1,
    })),
  ];

  console.log('batch', JSON.stringify(batch, null, 2));

  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: batch as never },
  });
  console.log('create without delete', res.code, res.msg);
}

main().catch(console.error);
