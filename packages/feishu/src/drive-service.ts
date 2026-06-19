import type { FeishuClient, NodeRef } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';
import { createEmptyDocument, replaceDocumentMarkdown } from './docx-content.js';

export async function createDriveFolder(
  client: FeishuClient,
  options: { parentFolderToken: string; name: string },
): Promise<NodeRef> {
  const response = await withRateLimit(() =>
    client.drive.v1.file.createFolder({
      data: {
        name: options.name.slice(0, 256),
        folder_token: options.parentFolderToken,
      },
    }),
  );
  assertFeishuResponse(response, 'Create drive folder');

  const token = response.data?.token;
  if (!token) {
    throw new Error('Create drive folder returned empty token');
  }

  return {
    token,
    nodeType: 'folder',
    title: options.name,
  };
}

export async function createDriveDocument(
  client: FeishuClient,
  options: { parentFolderToken: string; title: string },
): Promise<NodeRef> {
  const documentId = await createEmptyDocument(client, {
    folderToken: options.parentFolderToken,
    title: options.title,
  });

  return {
    token: documentId,
    docToken: documentId,
    nodeType: 'docx',
    title: options.title,
  };
}

export async function moveDriveFile(
  client: FeishuClient,
  options: {
    fileToken: string;
    type: 'docx' | 'folder' | 'file';
    targetFolderToken: string;
  },
): Promise<void> {
  const response = await withRateLimit(() =>
    client.drive.v1.file.move({
      path: { file_token: options.fileToken },
      data: {
        type: options.type,
        folder_token: options.targetFolderToken,
      },
    }),
  );
  assertFeishuResponse(response, 'Move drive file');
}

export async function listDriveFolderChildren(
  client: FeishuClient,
  folderToken: string,
): Promise<Array<{ token: string; name: string; type: string }>> {
  const response = await withRateLimit(() =>
    client.drive.v1.file.list({
      params: {
        folder_token: folderToken,
        page_size: 200,
      },
    }),
  );
  assertFeishuResponse(response, 'List drive folder children');

  return (response.data?.files ?? []).map((file) => ({
    token: file.token ?? '',
    name: file.name ?? '',
    type: file.type ?? '',
  }));
}

export async function findDriveChildByName(
  client: FeishuClient,
  parentFolderToken: string,
  name: string,
): Promise<NodeRef | null> {
  const items = await listDriveFolderChildren(client, parentFolderToken);
  const matched = items.find((item) => item.name === name);
  if (!matched?.token) return null;

  if (matched.type === 'folder') {
    return { token: matched.token, nodeType: 'folder', title: matched.name };
  }
  if (matched.type === 'docx') {
    return {
      token: matched.token,
      docToken: matched.token,
      nodeType: 'docx',
      title: matched.name,
    };
  }
  return { token: matched.token, nodeType: 'file', title: matched.name };
}

export { replaceDocumentMarkdown };
