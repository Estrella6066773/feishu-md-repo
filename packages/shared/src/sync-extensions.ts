function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

export function pathEndsWithExtension(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

export function allSyncDocExtensions(mdExtensions: string[], tabularExtensions: string[]): string[] {
  return [...mdExtensions, ...tabularExtensions];
}

export function isSyncableDocPath(
  path: string,
  mdExtensions: string[],
  tabularExtensions: string[],
): boolean {
  return (
    pathEndsWithExtension(path, mdExtensions) || pathEndsWithExtension(path, tabularExtensions)
  );
}

/** 从路径去掉已知扩展名，用作飞书文档标题 */
export function syncDocTitleFromPath(path: string, extensions: string[]): string {
  const base = basename(path);
  for (const ext of extensions) {
    if (base.toLowerCase().endsWith(ext.toLowerCase())) {
      return base.slice(0, -ext.length);
    }
  }
  return base;
}
