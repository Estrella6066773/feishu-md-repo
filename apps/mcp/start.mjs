/**
 * Cursor 用 `node apps/mcp/start.mjs` 启动。
 * 不要改成 `pnpm start`：pnpm 会往 stdout 打横幅，MCP 客户端会把整条连接判失败。
 * tsx 负责解析 workspace 包里的 TypeScript（这些包的导出直接指向 .ts）。
 */
import './stdio-guard.mjs';
import { register } from 'tsx/esm/api';

register();
await import('./src/index.ts');
