/**
 * stdio MCP 入口。由 start.mjs 在把 console 改到 stderr 之后加载。
 * 不要在本文件向 stdout 打印日志，否则 Cursor 无法解析协议帧。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFeishuTools } from './register-tools.js';

const server = new McpServer({
  name: 'feishu-md',
  version: '0.1.0',
});

registerFeishuTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
