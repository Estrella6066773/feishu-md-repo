/**
 * 把核心服务的 /mcp 转成 stdio，供 Cursor 在本机拉起。
 *
 * Cursor 对 type=http 的 MCP 是从云端去连的，127.0.0.1 到不了这台电脑，
 * 工具发现会失败。这个进程跑在本机，stdin/stdout 走 MCP，再转发到
 * http://127.0.0.1:8787/mcp（可用 FEISHU_MD_APP_MCP_URL 覆盖）。
 *
 * 标准输出只留给协议。连不上核心服务时把原因写到 stderr 并退出。
 * 核心服务必须先启动（pnpm dev:service 或桌面应用），且监听在回环地址。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const url = process.env.FEISHU_MD_APP_MCP_URL ?? 'http://127.0.0.1:8787/mcp';

const remote = new Client({ name: 'feishu-md-app-bridge', version: '0.1.0' });
let connected;

const server = new Server(
  { name: 'feishu-md-core', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  await connected;
  return remote.listTools(request.params);
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await connected;
  return remote.callTool(request.params);
});

// 先挂上 stdin，再去连 HTTP。否则握手期间 Cursor 发来的 initialize 会在没有监听器时被丢掉。
await server.connect(new StdioServerTransport());
connected = remote.connect(new StreamableHTTPClientTransport(new URL(url))).catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`无法连接核心服务 MCP ${url}。请先启动 pnpm dev:service。${detail}`);
  process.exit(1);
});
await connected;
