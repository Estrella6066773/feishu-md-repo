/** 在参考画板上复制 c4:13，验证 API 是否支持跨 section 连线 */
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
    path: { document_id: 'RrkJdUHs2oSgkBxK68Mc1EO6nxh' },
    params: { page_size: 500 },
  })).data?.items?.find((b) => b.block_type === 43)?.board?.token!;

  const nodes =
    ((await client.board.v1.whiteboardNode.list({ path: { whiteboard_id: wb } })).data as {
      nodes?: UnknownRecord[];
    })?.nodes ?? [];

  const template = nodes.find((n) => n.id === 'c4:13')!;
  const payload = structuredClone(template) as UnknownRecord;
  payload.id = 'probe:c99';

  const res = await client.board.v1.whiteboardNode.create({
    path: { whiteboard_id: wb },
    data: { nodes: [payload] as never },
  });
  console.log('clone c4:13 on ref board', res.code, res.msg);
}

main().catch(console.error);
