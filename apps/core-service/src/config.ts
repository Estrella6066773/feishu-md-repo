import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ServiceConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
}

export function loadConfig(): ServiceConfig {
  const port = Number(process.env.FEISHU_MD_PORT ?? 8787);
  const host = process.env.FEISHU_MD_HOST ?? '127.0.0.1';
  const dataDir =
    process.env.FEISHU_MD_DATA_DIR ?? join(homedir(), 'AppData', 'Roaming', 'feishu-md-repo');

  return {
    port,
    host,
    dataDir,
    dbPath: join(dataDir, 'app.db'),
  };
}

export function getPublicBaseUrl(config: ServiceConfig): string {
  return `http://${config.host}:${config.port}`;
}
