/**
 * 临时诊断脚本：读取指定飞书文档中的白板节点，输出到 JSON 文件。
 * 用法：node scripts/fetch-board-nodes.mjs <docUrl> <outPath>
 */
import { DatabaseSync } from 'node:sqlite';
import * as lark from '@larksuiteoapi/node-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const dbPath = join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo', 'app.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db.prepare('SELECT key, value_json FROM app_settings').all();
const settings = {};
for (const r of rows) settings[r.key] = JSON.parse(r.value_json);

let credentials = null;
const bots = settings.feishu_bots ?? [];
const botSettings = settings.bot_settings ?? {};
const defaultBotId = botSettings.defaultBotId;
if (defaultBotId) {
  const profile = bots.find((b) => b.id === defaultBotId);
  if (profile) credentials = { appId: profile.appId, appSecret: profile.appSecret };
}
if (!credentials) credentials = settings.feishu_credentials ?? null;

if (!credentials?.appId || !credentials?.appSecret) {
  console.error('未找到飞书凭据');
  process.exit(1);
}

const client = new lark.Client({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const docUrl = process.argv[2];
if (!docUrl) {
  console.error('请传入文档 URL');
  process.exit(1);
}

const outPath = process.argv[3] || 'board-nodes.json';

async function findBoardWhiteboardId(documentId) {
  const resp = await client.docx.v1.documentBlock.list({
    path: { document_id: documentId },
    params: { page_size: 500 },
  });
  const items = resp.data?.items ?? [];
  for (const item of items) {
    if (item.block_type === 43 && item.board?.token) {
      return String(item.board.token);
    }
  }
  return null;
}

async function main() {
  const docxMatch = /\/docx\/([A-Za-z0-9_-]+)/.exec(docUrl.trim());
  const wikiMatch = /\/wiki\/([A-Za-z0-9_-]+)/.exec(docUrl.trim());
  const token = docxMatch?.[1] ?? wikiMatch?.[1];
  if (!token) {
    console.error('无法从 URL 提取 token:', docUrl);
    process.exit(1);
  }

  let whiteboardId = null;
  const boardDirect = /\/board\/([A-Za-z0-9_-]+)/.exec(docUrl.trim());
  if (boardDirect) {
    whiteboardId = boardDirect[1];
    console.log('画板直链 whiteboard_id:', whiteboardId);
  } else {
    console.log('文档 token:', token);
    whiteboardId = await findBoardWhiteboardId(token);
    if (!whiteboardId) {
      console.error('文档中未找到画板块');
      process.exit(1);
    }
    console.log('找到 whiteboard_id:', whiteboardId);
  }

  const resp = await client.board.v1.whiteboardNode.list({
    path: { whiteboard_id: whiteboardId },
  });
  const nodes = resp.data?.nodes ?? [];
  console.log(`节点总数: ${nodes.length}`);

  writeFileSync(outPath, JSON.stringify(nodes, null, 2), 'utf8');
  console.log(`已写入: ${outPath}`);
}

main().catch((e) => {
  console.error('失败:', e.message ?? e);
  process.exit(1);
});
