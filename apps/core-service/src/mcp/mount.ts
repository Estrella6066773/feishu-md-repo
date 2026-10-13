import { createLogger } from '@feishu-md/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { isLoopbackHost, type McpControlDeps } from './deps.js';
import { registerControlTools } from './register-tools.js';

const mcpLog = createLogger('mcp');

/**
 * 把 MCP 挂到核心服务的 /mcp。
 * 每个请求新建一对 server 和 transport：这个传输是无会话的，重复使用会串消息 id。
 * 助手要先启动本工具（pnpm dev:service 或桌面应用）。
 * Cursor 云端连不到 127.0.0.1，配置里应走 mcp-stdio-bridge.mjs，由本机进程转发到这里。
 * 返回值表示这次是否真正挂上了路由，供启动日志使用。
 */
export function mountControlMcp(app: Hono, deps: McpControlDeps): boolean {
  if (!isLoopbackHost(deps.config.host)) {
    mcpLog.warn(
      `核心服务绑定在 ${deps.config.host}，不是本机回环地址，已不挂载 /mcp。把 FEISHU_MD_HOST 设为 127.0.0.1 后再启用。`,
    );
    return false;
  }

  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = new McpServer({
      name: 'feishu-md-core',
      version: '0.1.0',
    });
    registerControlTools(server, deps);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  mcpLog.info(`内置 MCP 已挂载：http://${deps.config.host}:${deps.config.port}/mcp`);
  return true;
}
