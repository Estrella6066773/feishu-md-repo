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
    `flowchart TB\n  A[节点A]\n  B[节点B]\n  A --> B`,
    0,
  );

  const nodes =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];
  const shapes = nodes.filter((n) => n.type === 'composite_shape');
  const [a, b] = shapes;

  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: {
      nodes: [
        {
          id: 'y1:c1',
          type: 'connector',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          angle: 0,
          style: {
            border_color: '#000000',
            border_color_type: 0,
            border_opacity: 100,
            border_style: 'solid',
            border_width: 'narrow',
            theme_border_color_code: -1,
          },
          connector: {
            shape: 'straight',
            specified_coordinate: true,
            caption_auto_direction: false,
            turning_points: [],
            start: {
              arrow_style: 'none',
              attached_object: { id: a!.id, snap_to: 'right', position: { x: 1, y: 0.5 } },
            },
            end: {
              arrow_style: 'triangle_arrow',
              attached_object: { id: b!.id, snap_to: 'left', position: { x: 0, y: 0.5 } },
            },
            start_object: { id: a!.id, snap_to: 'right', position: { x: 1, y: 0.5 } },
            end_object: { id: b!.id, snap_to: 'left', position: { x: 0, y: 0.5 } },
          },
          z_index: 2,
        },
      ] as never,
    },
  });
  console.log('global shapes connector', res.code, res.msg, a!.id, b!.id);
}

main().catch(console.error);
