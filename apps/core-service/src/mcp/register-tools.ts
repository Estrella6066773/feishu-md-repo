import {
  getBinding,
  getBotSettings,
  getCommentImportLog,
  getFeishuBots,
  getSyncLog,
  listBindings,
  listCommentImportLogs,
  listNodeMappings,
  listSyncLogs,
  resolveFeishuCredentials,
} from '@feishu-md/db';
import {
  appendMermaidBoardToDocument,
  createFeishuClient,
  exportDocumentToMarkdown,
  formatExportError,
  formatFeishuErrorMessage,
  toFeishuDocumentUrl,
} from '@feishu-md/feishu';
import type { Binding } from '@feishu-md/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findLocalBoundFiles, writeBoundMarkdownFile } from '../export-bound-file.js';
import type { McpControlDeps } from './deps.js';
import { jsonText, pageText } from './format.js';

/**
 * 这些工具是核心服务的控制面，不是另一套飞书客户端。
 * 同步和评论导入只入队并返回 logId，不在这次调用里等到结束；助手用 get_sync_log 看进度。
 * 手动同步会抢占同一绑定上正在跑的任务，和面板上的「立即同步」相同。
 */

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

function summarizeBinding(binding: Binding) {
  return {
    id: binding.id,
    name: binding.name,
    sourceType: binding.sourceType,
    repoPath: binding.repoPath,
    remoteUrl: binding.remoteUrl,
    branch: binding.branch,
    syncMode: binding.syncMode,
    target: binding.feishuTarget,
    triggers: binding.triggers,
    botId: binding.botId,
    lastSyncedSha: binding.lastSyncedSha,
    lastSyncedAt: binding.lastSyncedAt,
  };
}

async function resolveBinding(db: McpControlDeps['db'], ref: string): Promise<Binding> {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error('请提供绑定 id 或名称');
  const direct = await getBinding(db, trimmed);
  if (direct) return direct;
  const matches = (await listBindings(db)).filter((binding) => binding.name === trimmed);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`未找到绑定「${trimmed}」`);
  throw new Error(
    `有多个绑定名叫「${trimmed}」，请改用 id：${matches.map((binding) => binding.id).join('、')}`,
  );
}

export function registerControlTools(server: McpServer, deps: McpControlDeps): void {
  const { db, config, queue, syncCoordinator, commentImportCoordinator, botManager } = deps;

  server.registerTool(
    'app_status',
    {
      title: '本工具状态',
      description:
        '查看正在运行的飞书文档同步服务：队列、机器人长连接、默认凭证是否已配置（不返回密钥）、数据目录。操作同步或评论导入前可先看队列是否已有任务。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const [credentials, bots, botSettings] = await Promise.all([
          resolveFeishuCredentials(db),
          getFeishuBots(db),
          getBotSettings(db),
        ]);
        const active = credentials
          ? bots.find((bot) => bot.appId === credentials.appId)
          : undefined;
        return jsonText({
          ok: true,
          listen: `http://${config.host}:${config.port}`,
          mcp: '/mcp',
          dataDir: config.dataDir,
          queue: queue.getStatus(),
          botConnection: botManager.getStatus(),
          credentials: credentials
            ? {
                configured: true,
                appId: credentials.appId,
                botId: active?.id,
                botName: active?.name,
                defaultBotId: botSettings.defaultBotId,
              }
            : { configured: false },
          bots: bots.map((bot) => ({ id: bot.id, name: bot.name, appId: bot.appId })),
        });
      }),
  );

  server.registerTool(
    'list_bindings',
    {
      title: '列出同步绑定',
      description: '列出本工具里配置的 Git 仓库与飞书位置绑定，含 id、仓库路径、知识库或云空间目标、触发方式。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const bindings = await listBindings(db);
        return jsonText({
          count: bindings.length,
          bindings: bindings.map(summarizeBinding),
        });
      }),
  );

  server.registerTool(
    'get_binding',
    {
      title: '查看一个绑定',
      description: '按绑定 id 或名称查看完整配置。名称重复时会要求改用 id。',
      inputSchema: {
        binding: z.string().describe('绑定 id 或名称'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ binding }) =>
      run(async () => jsonText(summarizeBinding(await resolveBinding(db, binding)))),
  );

  server.registerTool(
    'sync_binding',
    {
      title: '同步一个绑定',
      description:
        '把该绑定按 Git 内容推到飞书，和面板「立即同步」相同。调用立刻返回 logId，同步在服务队列里执行。手动触发会抢占这个绑定上正在进行的同步或评论导入。完成后用 get_sync_log 查看结果。fullResync 做修复同步；forceRewriteAll 会重写全部正文。',
      inputSchema: {
        binding: z.string().describe('绑定 id 或名称'),
        fullResync: z.boolean().optional().describe('修复同步：检查结构并重写异常正文'),
        forceRewriteAll: z.boolean().optional().describe('强制重写全部正文，会同时打开修复同步'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ binding, fullResync, forceRewriteAll }) =>
      run(async () => {
        const found = await resolveBinding(db, binding);
        const rewrite = forceRewriteAll === true;
        const repair = rewrite || fullResync === true;
        const logId = syncCoordinator.enqueueBindingSync(found.id, 'manual', repair, rewrite);
        return jsonText({
          ok: true,
          queued: true,
          bindingId: found.id,
          bindingName: found.name,
          logId,
          fullResync: repair,
          forceRewriteAll: rewrite,
          queue: queue.getStatus(),
        });
      }),
  );

  server.registerTool(
    'import_comments',
    {
      title: '导入飞书评论',
      description:
        '从该绑定已同步的飞书文档拉取评论，写入仓库的 .feishu/comments/。立刻返回 logId，用 get_comment_import_log 查看是否完成。手动触发会抢占这个绑定上正在进行的任务。',
      inputSchema: {
        binding: z.string().describe('绑定 id 或名称'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ binding }) =>
      run(async () => {
        const found = await resolveBinding(db, binding);
        const logId = commentImportCoordinator.enqueueCommentImport(found.id, 'manual');
        return jsonText({
          ok: true,
          queued: true,
          bindingId: found.id,
          bindingName: found.name,
          logId,
          queue: queue.getStatus(),
        });
      }),
  );

  server.registerTool(
    'get_sync_log',
    {
      title: '查看同步日志',
      description:
        '查看一次同步的状态、阶段和消息。status 为 pending 或 running 时稍后再次调用。不传 logId 时返回该绑定最近一条。',
      inputSchema: {
        logId: z.string().optional().describe('sync_binding 返回的 logId'),
        binding: z.string().optional().describe('绑定 id 或名称。未提供 logId 时用来取最近一条'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ logId, binding }) =>
      run(async () => {
        if (logId?.trim()) {
          const log = await getSyncLog(db, logId.trim());
          if (!log) throw new Error(`未找到同步日志 ${logId}`);
          return jsonText(log);
        }
        if (!binding?.trim()) throw new Error('请提供 logId，或提供 binding 以查看最近一条');
        const found = await resolveBinding(db, binding);
        const [latest] = await listSyncLogs(db, found.id);
        if (!latest) return jsonText({ bindingId: found.id, log: null });
        return jsonText(latest);
      }),
  );

  server.registerTool(
    'list_sync_logs',
    {
      title: '列出同步日志',
      description: '按时间从新到旧列出同步日志。可限定某个绑定。默认 10 条，最多 30 条。',
      inputSchema: {
        binding: z.string().optional().describe('绑定 id 或名称。省略则列出全部绑定'),
        limit: z.number().int().positive().optional().describe('条数，默认 10，最多 30'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ binding, limit }) =>
      run(async () => {
        const cap = Math.min(limit ?? 10, 30);
        const bindingId = binding?.trim() ? (await resolveBinding(db, binding)).id : undefined;
        const logs = await listSyncLogs(db, bindingId);
        return jsonText({ count: logs.length, returned: Math.min(cap, logs.length), logs: logs.slice(0, cap) });
      }),
  );

  server.registerTool(
    'get_comment_import_log',
    {
      title: '查看评论导入日志',
      description: '查看一次评论导入是否完成。不传 logId 时返回该绑定最近一条。',
      inputSchema: {
        logId: z.string().optional().describe('import_comments 返回的 logId'),
        binding: z.string().optional().describe('绑定 id 或名称。未提供 logId 时用来取最近一条'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ logId, binding }) =>
      run(async () => {
        if (logId?.trim()) {
          const log = await getCommentImportLog(db, logId.trim());
          if (!log) throw new Error(`未找到评论导入日志 ${logId}`);
          return jsonText(log);
        }
        if (!binding?.trim()) throw new Error('请提供 logId，或提供 binding 以查看最近一条');
        const found = await resolveBinding(db, binding);
        const [latest] = await listCommentImportLogs(db, found.id);
        if (!latest) return jsonText({ bindingId: found.id, log: null });
        return jsonText(latest);
      }),
  );

  server.registerTool(
    'list_comment_import_logs',
    {
      title: '列出评论导入日志',
      description: '按时间从新到旧列出评论导入日志。默认 10 条，最多 30 条。',
      inputSchema: {
        binding: z.string().optional().describe('绑定 id 或名称'),
        limit: z.number().int().positive().optional().describe('条数，默认 10，最多 30'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ binding, limit }) =>
      run(async () => {
        const cap = Math.min(limit ?? 10, 30);
        const bindingId = binding?.trim() ? (await resolveBinding(db, binding)).id : undefined;
        const logs = await listCommentImportLogs(db, bindingId);
        return jsonText({ count: logs.length, returned: Math.min(cap, logs.length), logs: logs.slice(0, cap) });
      }),
  );

  server.registerTool(
    'find_synced_document',
    {
      title: '查找已同步文档',
      description:
        '在本工具保存的节点映射里，按 Git 路径片段、token 或链接查找飞书文档。返回的 url 可交给 export_document。',
      inputSchema: {
        query: z.string().describe('路径片段、token 或链接，例如 Docs/README.md'),
        binding: z.string().optional().describe('绑定 id 或名称。省略则搜索全部绑定'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, binding }) =>
      run(async () => {
        const needle = query.trim().toLowerCase();
        if (!needle) throw new Error('query 不能为空');
        const bindings = binding?.trim()
          ? [await resolveBinding(db, binding)]
          : await listBindings(db);
        const hits: Array<Record<string, string | undefined>> = [];
        for (const item of bindings) {
          const mappings = await listNodeMappings(db, item.id);
          for (const mapping of mappings) {
            const url = toFeishuDocumentUrl(mapping);
            const haystack = `${mapping.gitPath}\n${url}\n${mapping.feishuDocToken ?? ''}\n${mapping.feishuNodeToken}`.toLowerCase();
            if (!haystack.includes(needle)) continue;
            hits.push({
              bindingId: item.id,
              bindingName: item.name,
              gitPath: mapping.gitPath,
              nodeType: mapping.feishuNodeType,
              url,
              documentId: mapping.feishuDocToken,
              nodeToken: mapping.feishuNodeToken,
            });
            if (hits.length >= 40) break;
          }
          if (hits.length >= 40) break;
        }
        return jsonText({ count: hits.length, truncated: hits.length >= 40, documents: hits });
      }),
  );

  server.registerTool(
    'export_document',
    {
      title: '导出飞书文档',
      description:
        '用本工具已配置的飞书应用，把云文档导出为 Markdown。这是工具箱的导出，不是绕过服务另开客户端。writeToBoundPath 为 true 时，把结果写回本地绑定仓库里对应的文件。正文过长时用 offset 续读。',
      inputSchema: {
        documentUrl: z.string().describe('飞书文档链接，需含 /docx/ 或 /wiki/'),
        writeToBoundPath: z.boolean().optional().describe('为 true 时写回本地绑定文件'),
        binding: z.string().optional().describe('写回时若同一文档对应多个绑定，用它指定绑定 id 或名称'),
        offset: z.number().int().nonnegative().optional().describe('从第几个字符开始返回'),
        maxChars: z.number().int().positive().optional().describe('本次最多返回的字符数，默认 48000'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentUrl, writeToBoundPath, binding, offset, maxChars }) =>
      run(async () => {
        const credentials = await resolveFeishuCredentials(db);
        if (!credentials?.appId || !credentials.appSecret) {
          throw new Error('飞书凭证未配置。请先在本工具的设置页保存机器人。');
        }
        const client = createFeishuClient(credentials);
        let exported: { title?: string; markdown: string };
        try {
          exported = await exportDocumentToMarkdown(client, { documentUrl: documentUrl.trim() });
        } catch (error) {
          throw new Error(formatExportError(error));
        }
        const localTargets = await findLocalBoundFiles(db, documentUrl.trim());
        let writtenPath: string | undefined;
        if (writeToBoundPath) {
          const bindingId = binding?.trim() ? (await resolveBinding(db, binding)).id : undefined;
          const written = await writeBoundMarkdownFile(db, documentUrl.trim(), exported.markdown, bindingId);
          writtenPath = written.absolutePath;
        }
        const page = pageText(exported.markdown, offset, maxChars);
        return jsonText({
          title: exported.title,
          totalChars: page.totalChars,
          offset: page.offset,
          nextOffset: page.nextOffset,
          truncated: page.truncated,
          localTargets,
          writtenPath,
          markdown: page.text,
        });
      }),
  );

  server.registerTool(
    'write_bound_file',
    {
      title: '写回绑定的仓库文件',
      description:
        '把 Markdown 写入本工具映射到这篇飞书文档的本地仓库文件。只写本地绑定，不直接改飞书。要更新飞书，写完后再调用 sync_binding。会覆盖该文件的现有内容。',
      inputSchema: {
        documentUrl: z.string().describe('飞书文档链接'),
        markdown: z.string().describe('要写入仓库文件的 Markdown'),
        binding: z.string().optional().describe('绑定 id 或名称。一篇文档对应多个本地文件时必填'),
        gitPath: z.string().optional().describe('绑定内的 Git 路径。同一文档有多条映射时用来消歧'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ documentUrl, markdown, binding, gitPath }) =>
      run(async () => {
        if (!markdown.trim()) throw new Error('markdown 不能为空');
        const bindingId = binding?.trim() ? (await resolveBinding(db, binding)).id : undefined;
        const written = await writeBoundMarkdownFile(
          db,
          documentUrl.trim(),
          markdown,
          bindingId,
          gitPath?.trim() || undefined,
        );
        return jsonText({
          ok: true,
          writtenPath: written.absolutePath,
          bindingId: written.bindingId,
          bindingName: written.bindingName,
          gitPath: written.gitPath,
        });
      }),
  );

  server.registerTool(
    'append_diagram',
    {
      title: '向飞书文档追加画板',
      description:
        '把一张 Mermaid 图追加到指定飞书云文档末尾，使用本工具已配置的应用凭证。不改动文档里已有的正文。',
      inputSchema: {
        documentUrl: z.string().describe('飞书文档链接'),
        mermaidCode: z.string().describe('Mermaid 源码，可以带或不带代码围栏'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ documentUrl, mermaidCode }) =>
      run(async () => {
        const credentials = await resolveFeishuCredentials(db);
        if (!credentials?.appId || !credentials.appSecret) {
          throw new Error('飞书凭证未配置。请先在本工具的设置页保存机器人。');
        }
        const client = createFeishuClient(credentials);
        try {
          const result = await appendMermaidBoardToDocument(client, {
            documentUrl: documentUrl.trim(),
            mermaidCode,
          });
          return jsonText(result);
        } catch (error) {
          throw new Error(formatExportError(error));
        }
      }),
  );
}
