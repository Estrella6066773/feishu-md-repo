import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 与 core-service 的 `loadConfig` 使用同一套数据目录约定，
 * 这样 MCP 打开的是桌面应用已经写入凭证的那个 SQLite，而不是另一份空库。
 */
export interface McpDataPaths {
  dataDir: string;
  dbPath: string;
}

export function resolveDataPaths(): McpDataPaths {
  const dataDir =
    process.env.FEISHU_MD_DATA_DIR ?? join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo');
  return {
    dataDir,
    dbPath: join(dataDir, 'app.db'),
  };
}
