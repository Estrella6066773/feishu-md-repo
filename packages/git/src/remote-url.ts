/**
 * 远程仓库 URL 归一化工具。
 *
 * 同一仓库可能以多种写法出现，例如：
 *   https://github.com/Estrella6066773/SpaceShip
 *   https://github.com/Estrella6066773/SpaceShip.git
 *   https://github.com/Estrella6066773/SpaceShip/
 * 归一化后比较可避免 `.git` 后缀、末尾斜杠、主机名大小写差异造成的误判。
 */

/**
 * 归一化远程仓库 URL，用于等价比较而非展示：
 * - 去除首尾空白
 * - 去除末尾 `.git` 与 `/`
 * - http/https 主机名统一小写
 * SSH scp 语法（git@host:path）非 URL 格式，仅做去尾处理。
 */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim();
  if (!value) return value;

  value = value.replace(/\.git\/?$/, '');
  value = value.replace(/\/+$/, '');

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.hostname = parsed.hostname.toLowerCase();
      value = parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    // 非标准 URL（如 SSH scp 语法）保持原样
  }

  return value;
}

/** 判断两个远程 URL 是否指向同一仓库（忽略 `.git` 后缀与末尾斜杠等格式差异） */
export function remoteUrlsEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeRemoteUrl(a) === normalizeRemoteUrl(b);
}
