/**
 * 读取飞书 docx 文档与画板节点，分析链接在 API 中的实际结构。
 *
 * 用法：pnpm exec tsx scripts/inspect-feishu-doc-links.ts [document_id]
 * 默认 document_id：RrkJdUHs2oSgkBxK68Mc1EO6nxh
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient } from '@feishu-md/feishu';

const BOARD_BLOCK_TYPE = 43;
const DEFAULT_DOCUMENT_ID = 'RrkJdUHs2oSgkBxK68Mc1EO6nxh';

type FeishuResponse = { code?: number; msg?: string; data?: unknown };

function assertFeishuResponse(response: FeishuResponse, action: string): void {
  if (response.code !== 0) {
    throw new Error(`${action} failed: ${response.msg ?? 'unknown error'} (code ${response.code ?? '?'})`);
  }
}

type UnknownRecord = Record<string, unknown>;

function dbPathFromEnv(): string {
  const dataDir =
    process.env.FEISHU_MD_DATA_DIR ?? join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo');
  return join(dataDir, 'app.db');
}

function pickTextLinks(text: UnknownRecord | undefined): UnknownRecord | null {
  if (!text) return null;

  const richText = text.rich_text as UnknownRecord | undefined;
  if (!richText) {
    return {
      plainText: text.text,
      richText: null,
    };
  }

  const paragraphs = (richText.paragraphs as UnknownRecord[] | undefined) ?? [];
  const elements = paragraphs.flatMap((paragraph) =>
    ((paragraph.elements as UnknownRecord[] | undefined) ?? []).map((element) => ({
      element_type: element.element_type,
      text_element: element.text_element,
      link_element: element.link_element,
      mention_doc_element: element.mention_doc_element,
    })),
  );

  return { plainText: text.text, elements };
}

function summarizeBoardNode(node: UnknownRecord): UnknownRecord {
  const text = node.text as UnknownRecord | undefined;
  return {
    id: node.id,
    type: node.type,
    mind_map_root: node.mind_map_root,
    mind_map_node: node.mind_map_node,
    textLinks: pickTextLinks(text),
  };
}

async function main(): Promise<void> {
  const documentId = process.argv[2]?.trim() || DEFAULT_DOCUMENT_ID;
  const dbPath = dbPathFromEnv();

  const { db } = createDb({ dbPath, runMigrations: false });
  const credentials = await getFeishuCredentials(db);
  if (!credentials) {
    console.error(`未找到飞书凭证，请先在 UI 设置页配置。数据库：${dbPath}`);
    process.exit(1);
  }

  const client = createFeishuClient(credentials);
  console.log(`文档 ID: ${documentId}`);
  console.log(`数据库: ${dbPath}`);
  console.log('---');

  const docResponse = await client.docx.v1.document.get({
    path: { document_id: documentId },
  });
  assertFeishuResponse(docResponse, 'Get docx document');
  console.log('文档标题:', docResponse.data?.document?.title ?? '(无)');

  const blockResponse = await client.docx.v1.documentBlock.list({
    path: { document_id: documentId },
    params: { page_size: 500 },
  });
  assertFeishuResponse(blockResponse, 'List docx blocks');

  const items = blockResponse.data?.items ?? [];
  const boardBlocks = items.filter((item) => item.block_type === BOARD_BLOCK_TYPE);
  console.log(`块总数: ${items.length}，画板块: ${boardBlocks.length}`);

  if (boardBlocks.length === 0) {
    console.log('该文档没有画板块。');
    return;
  }

  for (const boardBlock of boardBlocks) {
    const whiteboardId = boardBlock.board?.token;
    console.log('\n=== 画板块 ===');
    console.log('block_id:', boardBlock.block_id);
    console.log('whiteboard_id:', whiteboardId);

    if (!whiteboardId) continue;

    const nodesResponse = await client.board.v1.whiteboardNode.list({
      path: { whiteboard_id: whiteboardId },
    });
    assertFeishuResponse(nodesResponse, 'List board nodes');

    const nodes = (nodesResponse.data as { nodes?: UnknownRecord[] } | undefined)?.nodes ?? [];
    const typeCounts = new Map<string, number>();
    for (const node of nodes) {
      const nodeType = String(node.type ?? 'unknown');
      typeCounts.set(nodeType, (typeCounts.get(nodeType) ?? 0) + 1);
    }
    console.log(`画板节点总数: ${nodes.length}`);
    console.log('节点类型统计:', Object.fromEntries(typeCounts));

    const nodesWithLinks = nodes.filter((node) => {
      const text = node.text as UnknownRecord | undefined;
      const richText = text?.rich_text as UnknownRecord | undefined;
      const paragraphs = (richText?.paragraphs as UnknownRecord[] | undefined) ?? [];
      return paragraphs.some((paragraph) =>
        ((paragraph.elements as UnknownRecord[] | undefined) ?? []).some(
          (element) => element.element_type === 1 || element.element_type === 3,
        ),
      );
    });

    console.log(`含链接的节点: ${nodesWithLinks.length}`);

    for (const node of nodesWithLinks.slice(0, 20)) {
      console.log('\n--- 含链接的节点 ---');
      console.log(JSON.stringify(summarizeBoardNode(node), null, 2));
    }

    if (nodesWithLinks.length > 20) {
      console.log(`\n... 另有 ${nodesWithLinks.length - 20} 个含链接节点未展开`);
    }

    console.log('\n=== 链接用法归纳 ===');
    for (const node of nodesWithLinks) {
      const summary = summarizeBoardNode(node) as {
        id?: string;
        textLinks?: { plainText?: unknown; elements?: UnknownRecord[] };
      };
      const label =
        summary.textLinks?.plainText ??
        summary.textLinks?.elements?.map((element) => {
          if (element.link_element) {
            const link = element.link_element as UnknownRecord;
            return `[link] text=${link.text} herf=${link.herf}`;
          }
          if (element.mention_doc_element) {
            const doc = element.mention_doc_element as UnknownRecord;
            return `[mention_doc] doc_url=${doc.doc_url}`;
          }
          if (element.text_element) {
            const text = element.text_element as UnknownRecord;
            return `[text] ${text.text}`;
          }
          return `[type=${element.element_type}]`;
        }).join(' | ') ??
        '(无文字)';

      console.log(`${summary.id} (${node.type}): ${label}`);
    }

    if (nodesWithLinks.length === 0) {
      console.log('未发现 link_element / mention_doc 节点，展示前 5 个节点的 text 结构：');
      for (const node of nodes.slice(0, 5)) {
        console.log(JSON.stringify(summarizeBoardNode(node), null, 2));
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
