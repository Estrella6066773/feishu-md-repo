import {
  appendDocumentMarkdown,
  createEmptyDocument,
  createWikiDocxNode,
  exportDocumentToMarkdown,
  formatFeishuErrorMessage,
  listAllDocumentComments,
  listWikiChildNodes,
  listWikiSpaces,
  replaceDocumentMarkdown,
  toFeishuDocumentUrl,
  updateDocxDocumentTitle,
  updateWikiNodeTitle,
} from '@feishu-md/feishu';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  appDatabaseExists,
  findManagedDocuments,
  listStoredBindings,
  listStoredNodeMappings,
  withAppDatabase,
} from './app-db.js';
import { resolveDocument, type ResolvedDocument } from './documents.js';
import { jsonText, pageText, summarizeComments } from './format.js';
import { describeCredentialSetup, openFeishuSession } from './session.js';

/**
 * 把本仓库已有的飞书读写能力注册成 MCP 工具。
 * 工具只编排参数和返回文本；创建节点、转换 Markdown、导出正文都调用 packages/feishu，避免在这里再写一套 Open API。
 * 凭证来自 session.ts：与桌面应用共用 SQLite，调用结果里不能出现 appSecret。
 * 写工具会查 node_mappings：文档若已被绑定，返回 syncOverwriteWarning，提醒下次 Git 同步会覆盖飞书正文。
 */

const botIdField = z
  .string()
  .optional()
  .describe('机器人档案 ID 或名称。省略时依次使用 FEISHU_MD_BOT_ID、环境变量凭证、应用设置里的默认机器人。');

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: formatFeishuErrorMessage(error) }],
  };
}

async function run(action: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    return fail(error);
  }
}

function syncOverwriteWarning(resolved: ResolvedDocument): string | undefined {
  if (!appDatabaseExists()) return undefined;
  const hits = withAppDatabase((db) =>
    findManagedDocuments(db, [resolved.documentId, resolved.nodeToken, resolved.url]),
  );
  if (hits.length === 0) return undefined;
  const details = hits.map((hit) => `绑定「${hit.bindingName}」→ ${hit.gitPath}`).join('；');
  return `该文档已被 Git 同步绑定纳管。下次同步会用仓库文件覆盖飞书正文。${details}`;
}

async function applyTitle(
  client: Awaited<ReturnType<typeof openFeishuSession>>['client'],
  resolved: ResolvedDocument,
  title: string,
): Promise<void> {
  await updateDocxDocumentTitle(client, resolved.documentId, title);
  if (resolved.source === 'wiki' && resolved.spaceId && resolved.nodeToken) {
    await updateWikiNodeTitle(client, {
      spaceId: resolved.spaceId,
      nodeToken: resolved.nodeToken,
      title,
    });
  }
}

export function registerFeishuTools(server: McpServer): void {
  server.registerTool(
    'feishu_status',
    {
      title: '飞书连接状态',
      description:
        '查看 MCP 将使用哪套飞书凭证（不返回密钥）：数据目录、机器人档案、默认机器人，以及当前会实际启用的 appId。读写文档前若不确定凭证是否就绪，先调用本工具。',
      inputSchema: { botId: botIdField },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ botId }) =>
      run(async () => {
        const setup = await describeCredentialSetup();
        let active: Record<string, string | undefined> | undefined;
        let activeError: string | undefined;
        try {
          const session = await openFeishuSession(botId);
          active = {
            source: session.source,
            appId: session.appId,
            botId: session.botId,
            botName: session.botName,
          };
        } catch (error) {
          activeError = formatFeishuErrorMessage(error);
        }
        return jsonText({ ...setup, active, activeError });
      }),
  );

  server.registerTool(
    'feishu_list_bindings',
    {
      title: '列出同步绑定',
      description:
        '列出本机已配置的 Git 仓库与飞书知识库/云空间绑定，含 spaceId、根节点 token。用于找到文档所在知识库，不会访问飞书网络。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const bindings = withAppDatabase((db) => listStoredBindings(db));
        return jsonText({
          count: bindings.length,
          bindings: bindings.map((binding) => ({
            id: binding.id,
            name: binding.name,
            repoPath: binding.repoPath,
            branch: binding.branch,
            syncMode: binding.syncMode,
            target: binding.feishuTarget,
          })),
        });
      }),
  );

  server.registerTool(
    'feishu_find_synced_document',
    {
      title: '按路径查找已同步文档',
      description:
        '在本机节点映射里按 Git 路径片段查找已经同步到飞书的文档，返回可交给 feishu_read_document 的链接。不访问飞书网络。query 匹配 gitPath、文档 token 或已保存的链接。',
      inputSchema: {
        query: z.string().describe('路径片段或 token，例如 Docs/README.md'),
        bindingId: z.string().optional().describe('绑定 ID 或绑定名称。省略则搜索全部绑定。'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, bindingId }) =>
      run(async () => {
        const needle = query.trim().toLowerCase();
        if (!needle) throw new Error('query 不能为空');

        const hits = withAppDatabase((db) => {
          const bindings = listStoredBindings(db);
          const selected = bindingId
            ? bindings.filter((binding) => binding.id === bindingId || binding.name === bindingId)
            : bindings;
          if (bindingId && selected.length === 0) {
            throw new Error(`未找到绑定「${bindingId}」`);
          }

          const found: Array<Record<string, string | undefined>> = [];
          for (const binding of selected) {
            const mappings = listStoredNodeMappings(db, binding.id);
            for (const mapping of mappings) {
              const url = toFeishuDocumentUrl(mapping);
              const haystack = `${mapping.gitPath}\n${url}\n${mapping.feishuDocToken ?? ''}\n${mapping.feishuNodeToken}`.toLowerCase();
              if (!haystack.includes(needle)) continue;
              found.push({
                bindingId: binding.id,
                bindingName: binding.name,
                gitPath: mapping.gitPath,
                nodeType: mapping.feishuNodeType,
                url,
                documentId: mapping.feishuDocToken,
                nodeToken: mapping.feishuNodeToken,
              });
              if (found.length >= 40) break;
            }
            if (found.length >= 40) break;
          }
          return found;
        });

        return jsonText({ count: hits.length, truncated: hits.length >= 40, documents: hits });
      }),
  );

  server.registerTool(
    'feishu_list_wiki_spaces',
    {
      title: '列出知识库',
      description: '列出当前飞书应用有权限看到的知识库，返回 spaceId。创建知识库文档前需要它。',
      inputSchema: { botId: botIdField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ botId }) =>
      run(async () => {
        const session = await openFeishuSession(botId);
        const spaces = await listWikiSpaces(session.client);
        return jsonText({ appId: session.appId, botName: session.botName, spaces });
      }),
  );

  server.registerTool(
    'feishu_list_wiki_nodes',
    {
      title: '列出知识库子节点',
      description:
        '列出某个知识库节点下的直接子节点。不传 parentNodeToken 时列出该空间根目录。返回的 nodeToken 可继续列子节点，objToken 是云文档 document_id。',
      inputSchema: {
        spaceId: z.string().describe('知识库 space_id'),
        parentNodeToken: z.string().optional().describe('父节点 node_token。省略表示空间根目录。'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ spaceId, parentNodeToken, botId }) =>
      run(async () => {
        const session = await openFeishuSession(botId);
        const nodes = await listWikiChildNodes(session.client, spaceId, parentNodeToken);
        const limit = 200;
        const page = nodes.slice(0, limit).map((node) => ({
          title: node.title,
          nodeToken: node.nodeToken,
          objToken: node.objToken,
          objType: node.objType,
          url: node.nodeToken ? `https://feishu.cn/wiki/${node.nodeToken}` : undefined,
        }));
        return jsonText({
          count: nodes.length,
          returned: page.length,
          truncated: nodes.length > page.length,
          nodes: page,
        });
      }),
  );

  server.registerTool(
    'feishu_read_document',
    {
      title: '读取飞书文档',
      description:
        '把飞书云文档导出为 Markdown。入参可以是文档链接、/docx/ 或 /wiki/ 路径，或 token。含画板的文档会把画板转成 Mermaid。正文过长时用 offset 与 nextOffset 分页读取。',
      inputSchema: {
        url: z.string().describe('飞书文档链接或 token'),
        offset: z.number().int().nonnegative().optional().describe('从第几个字符开始返回，默认 0'),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('本次最多返回的字符数，默认 48000，上限 120000'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, offset, maxChars, botId }) =>
      run(async () => {
        const session = await openFeishuSession(botId);
        const resolved = await resolveDocument(session.client, url);
        const exported = await exportDocumentToMarkdown(session.client, {
          documentUrl: resolved.url,
          includeTitle: true,
        });
        const page = pageText(exported.markdown, offset, maxChars);
        return jsonText({
          title: exported.title ?? resolved.title,
          documentId: resolved.documentId,
          nodeToken: resolved.nodeToken,
          spaceId: resolved.spaceId,
          source: resolved.source,
          url: resolved.url,
          totalChars: page.totalChars,
          offset: page.offset,
          nextOffset: page.nextOffset,
          truncated: page.truncated,
          markdown: page.text,
        });
      }),
  );

  server.registerTool(
    'feishu_write_document',
    {
      title: '重写飞书文档正文',
      description:
        '清空指定飞书文档的正文，再按 Markdown 整篇写入。标题默认不变；传入 title 时同时修改文档标题，知识库节点会连节点标题一起改。Mermaid 代码块会画成飞书画板，GFM 表格会变成原生表格。本地图片文件不会从磁盘上传。这是破坏性操作，只在用户明确要求覆盖该文档时使用。若该文档已被 Git 同步绑定纳管，返回值会带 syncOverwriteWarning：下次同步仍会用仓库文件覆盖飞书正文。',
      inputSchema: {
        url: z.string().describe('要覆盖的飞书文档链接或 token'),
        markdown: z.string().describe('新的整篇 Markdown 正文'),
        title: z.string().optional().describe('可选。提供则在写入正文后更新标题。'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, markdown, title, botId }) =>
      run(async () => {
        if (!markdown.trim()) throw new Error('markdown 不能为空。若只想改标题，请使用 feishu_update_title。');
        const session = await openFeishuSession(botId);
        const resolved = await resolveDocument(session.client, url);
        await replaceDocumentMarkdown(session.client, resolved.documentId, markdown);
        if (title?.trim()) {
          await applyTitle(session.client, resolved, title.trim());
        }
        return jsonText({
          documentId: resolved.documentId,
          url: resolved.url,
          title: title?.trim() || resolved.title,
          charCount: markdown.length,
          syncOverwriteWarning: syncOverwriteWarning(resolved),
        });
      }),
  );

  server.registerTool(
    'feishu_append_document',
    {
      title: '追加飞书文档正文',
      description:
        '把 Markdown 追加到飞书文档末尾，不改动已有正文。Mermaid 代码块会画成飞书画板，GFM 表格会变成原生表格。本地图片文件不会从磁盘上传。若该文档已被 Git 同步绑定纳管，返回值会带 syncOverwriteWarning。',
      inputSchema: {
        url: z.string().describe('飞书文档链接或 token'),
        markdown: z.string().describe('追加到文末的 Markdown'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, markdown, botId }) =>
      run(async () => {
        if (!markdown.trim()) throw new Error('markdown 不能为空');
        const session = await openFeishuSession(botId);
        const resolved = await resolveDocument(session.client, url);
        const appended = await appendDocumentMarkdown(session.client, resolved.documentId, markdown);
        return jsonText({
          documentId: resolved.documentId,
          url: resolved.url,
          insertedBlockCount: appended.insertedBlockCount,
          syncOverwriteWarning: syncOverwriteWarning(resolved),
        });
      }),
  );

  server.registerTool(
    'feishu_create_document',
    {
      title: '创建飞书文档',
      description:
        '新建一篇云文档。target=wiki 时必须提供 spaceId，可选 parentNodeToken 作为父节点；target=drive 时可选 folderToken，省略则建在应用云空间根目录。可同时写入初始 Markdown。返回的 url 可继续用于读取或追加。',
      inputSchema: {
        title: z.string().describe('文档标题'),
        target: z.enum(['wiki', 'drive']).describe('wiki：知识库节点；drive：云空间文档'),
        spaceId: z.string().optional().describe('知识库 space_id。target=wiki 时必填。'),
        parentNodeToken: z.string().optional().describe('知识库父节点 node_token。省略则建在空间根目录。'),
        folderToken: z.string().optional().describe('云空间文件夹 token。仅 target=drive 时使用。'),
        markdown: z.string().optional().describe('可选的初始 Markdown 正文'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, target, spaceId, parentNodeToken, folderToken, markdown, botId }) =>
      run(async () => {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) throw new Error('title 不能为空');
        const session = await openFeishuSession(botId);

        if (target === 'wiki') {
          if (!spaceId?.trim()) throw new Error('在知识库创建文档时必须提供 spaceId');
          const node = await createWikiDocxNode(session.client, {
            spaceId: spaceId.trim(),
            parentNodeToken: parentNodeToken?.trim() || undefined,
            title: trimmedTitle,
          });
          if (!node.docToken) throw new Error('飞书创建知识库文档后没有返回 document_id');
          if (markdown?.trim()) {
            await replaceDocumentMarkdown(session.client, node.docToken, markdown);
          }
          return jsonText({
            documentId: node.docToken,
            nodeToken: node.nodeToken,
            url: node.url ?? (node.nodeToken ? `https://feishu.cn/wiki/${node.nodeToken}` : undefined),
            title: trimmedTitle,
          });
        }

        const created = await createEmptyDocument(session.client, {
          folderToken: folderToken?.trim() || undefined,
          title: trimmedTitle,
        });
        if (markdown?.trim()) {
          await replaceDocumentMarkdown(session.client, created.documentId, markdown);
        }
        return jsonText({
          documentId: created.documentId,
          url: created.url ?? `https://feishu.cn/docx/${created.documentId}`,
          title: trimmedTitle,
        });
      }),
  );

  server.registerTool(
    'feishu_update_title',
    {
      title: '修改飞书文档标题',
      description:
        '只修改文档标题，不改正文。若文档在知识库中，会同时更新节点标题和文档标题，避免两边不一致。',
      inputSchema: {
        url: z.string().describe('飞书文档链接或 token'),
        title: z.string().describe('新标题'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, title, botId }) =>
      run(async () => {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) throw new Error('title 不能为空');
        const session = await openFeishuSession(botId);
        const resolved = await resolveDocument(session.client, url);
        await applyTitle(session.client, resolved, trimmedTitle);
        return jsonText({
          documentId: resolved.documentId,
          nodeToken: resolved.nodeToken,
          url: resolved.url,
          title: trimmedTitle,
        });
      }),
  );

  server.registerTool(
    'feishu_list_comments',
    {
      title: '读取飞书文档评论',
      description: '读取一篇云文档的评论和回复文本，含划词引用。单次最多返回 50 条。需要应用具备文档评论读取权限。',
      inputSchema: {
        url: z.string().describe('飞书文档链接或 token'),
        botId: botIdField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, botId }) =>
      run(async () => {
        const session = await openFeishuSession(botId);
        const resolved = await resolveDocument(session.client, url);
        const records = await listAllDocumentComments(session.client, resolved.documentId);
        return jsonText({
          documentId: resolved.documentId,
          url: resolved.url,
          ...summarizeComments(records),
        });
      }),
  );
}
