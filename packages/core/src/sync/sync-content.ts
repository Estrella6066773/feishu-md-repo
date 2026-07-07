import {
  DEFAULT_REPOSITORY_OPTIONS,
  DEFAULT_WORKSPACE_OPTIONS,
  pathEndsWithExtension,
  type RepositoryOptions,
  type WorkspaceOptions,
} from '@feishu-md/shared';

export interface SyncDocExtensionOptions {
  mdExtensions: string[];
  tabularExtensions: string[];
}

export function resolveSyncDocExtensions(
  workspaceOptions?: WorkspaceOptions,
  repositoryOptions?: RepositoryOptions,
): SyncDocExtensionOptions {
  if (workspaceOptions) {
    const options = { ...DEFAULT_WORKSPACE_OPTIONS, ...workspaceOptions };
    return {
      mdExtensions: options.mdExtensions,
      tabularExtensions: options.tabularExtensions,
    };
  }

  const options = { ...DEFAULT_REPOSITORY_OPTIONS, ...repositoryOptions };
  return {
    mdExtensions: ['.md', '.markdown'],
    tabularExtensions: options.tabularExtensions,
  };
}

export async function readSyncableDocumentContent(
  path: string,
  readText: (path: string) => Promise<string | null>,
  extensions: SyncDocExtensionOptions,
): Promise<string | null> {
  const raw = await readText(path);
  if (raw == null) return null;

  if (pathEndsWithExtension(path, extensions.tabularExtensions)) {
    return raw;
  }

  if (pathEndsWithExtension(path, extensions.mdExtensions)) {
    return raw;
  }

  return null;
}
