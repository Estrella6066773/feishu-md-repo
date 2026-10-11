/**
 * MCP 走 stdio：stdout 只能出现协议帧。
 * 飞书适配层的 logger 默认写 console，这里在加载任何业务模块之前把 console 改到 stderr。
 * 必须作为 start.mjs 的第一个 import，ESM 会按 import 顺序先执行本文件。
 */
import { Console } from 'node:console';

const stderr = new Console(process.stderr, process.stderr);
console.log = stderr.log.bind(stderr);
console.info = stderr.info.bind(stderr);
console.debug = stderr.debug.bind(stderr);
console.warn = stderr.warn.bind(stderr);
console.error = stderr.error.bind(stderr);

if (!process.env.FEISHU_MD_LOG_LEVEL) {
  process.env.FEISHU_MD_LOG_LEVEL = 'warn';
}
