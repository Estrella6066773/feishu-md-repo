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
    path: { document_id: 'CeR5dDdDEoD3TwxfBbtcyGJrn0g' },
    params: { page_size: 500 },
  })).data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  const nodes =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];

  const section = nodes.find((n) => n.type === 'section');
  if (!section) {
    console.log('no section found');
    return;
  }

  const children = nodes.filter((n) => n.parent_id === section.id && n.type === 'composite_shape');
  console.log(
    'section',
    section.id,
    children.map((c) => ({ id: c.id, text: (c.text as UnknownRecord)?.text, x: c.x, y: c.y })),
  );

  if (children.length < 2) return;
  const [a, b] = children;

  const base = {
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
    z_index: 1,
  };

  for (const [name, extra] of [
    ['global', { id: 'z2:c1' }],
    ['in section', { id: 'z2:c2', parent_id: section.id, x: 40, y: 60 }],
    ['same batch', null],
  ] as const) {
    if (name === 'same batch') {
      const res = await client.board.v1.whiteboardNode.create({
        path: { whiteboard_id: wb },
        data: {
          nodes: [
            {
              id: 'z2:1',
              type: 'composite_shape',
              parent_id: section.id,
              x: 10,
              y: 120,
              width: 60,
              height: 40,
              angle: 0,
              text: { text: 'X' },
              composite_shape: { type: 'round_rect' },
              z_index: 3,
            },
            {
              ...base,
              id: 'z2:c3',
              parent_id: section.id,
              x: 10,
              y: 120,
              connector: {
                ...base.connector,
                end: {
                  arrow_style: 'triangle_arrow',
                  attached_object: { id: 'z2:1', snap_to: 'left', position: { x: 0, y: 0.5 } },
                },
                end_object: { id: 'z2:1', snap_to: 'left', position: { x: 0, y: 0.5 } },
              },
            },
          ] as never,
        },
      });
      console.log(name, res.code, res.msg);
      continue;
    }

    const res = await client.board.v1.whiteboardNode.create({
      path: { whiteboard_id: wb },
      data: { nodes: [{ ...base, ...extra }] as never },
    });
    console.log(name, res.code, res.msg);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch(console.error);
