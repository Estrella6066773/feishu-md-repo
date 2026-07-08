import type { FeishuClient, NodeRef } from './client.js';
import { createLogger } from '@feishu-md/shared';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
import { createEmptyDocument, replaceDocumentMarkdown } from './docx-content.js';

const driveApiLog = createLogger('drive-api');

type FeishuUploadResponse = { code?: number; msg?: string; data?: { file_token?: string } };

function extractUploadFileToken(response: unknown, action: string): string {
  const payload = response as FeishuUploadResponse | null;
  if (!payload) {
    throw new FeishuApiError(`${action} returned empty response`);
  }
  if (payload.code != null && payload.code !== 0) {
    throw new FeishuApiError(`${action} failed: ${payload.msg ?? 'unknown error'}`, payload.code);
  }

  const token =
    payload.data?.file_token
    ?? (payload as { file_token?: string }).file_token;
  if (!token) {
    throw new FeishuApiError(`${action} returned empty file_token`);
  }
  return token;
}

export async function createDriveFolder(
  client: FeishuClient,
  options: { parentFolderToken: string; name: string },
): Promise<NodeRef> {
  driveApiLog.debug('创建 Drive 文件夹', { name: options.name });
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
  driveApiLog.debug('创建 Drive 文档', { title: options.title });
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
  driveApiLog.debug('列出 Drive 文件夹子项', { folderToken });
  const files: Array<{ token: string; name: string; type: string }> = [];
  let pageToken: string | undefined;

  do {
    const response = await withRateLimit(() =>
      client.drive.v1.file.list({
        params: {
          folder_token: folderToken,
          page_size: 200,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    assertFeishuResponse(response, 'List drive folder children');

    for (const file of response.data?.files ?? []) {
      files.push({
        token: file.token ?? '',
        name: file.name ?? '',
        type: file.type ?? '',
      });
    }

    if (!response.data?.has_more) break;
    pageToken = response.data?.next_page_token;
  } while (pageToken);

  return files;
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

export async function deleteDriveFile(
  client: FeishuClient,
  options: { fileToken: string; type: 'docx' | 'folder' | 'file' },
): Promise<void> {
  driveApiLog.debug('删除 Drive 文件', { fileToken: options.fileToken, type: options.type });
  const response = await withRateLimit(() =>
    client.drive.v1.file.delete({
      path: { file_token: options.fileToken },
      params: { type: options.type },
    }),
  );
  assertFeishuResponse(response, 'Delete drive file');
}

export async function uploadDriveFile(
  client: FeishuClient,
  options: {
    parentFolderToken: string;
    fileName: string;
    data: Uint8Array;
  },
): Promise<string> {
  driveApiLog.debug('上传 Drive 文件', {
    fileName: options.fileName,
    size: options.data.byteLength,
  });
  const response = await withRateLimit(() =>
    client.drive.v1.file.uploadAll({
      data: {
        file_name: options.fileName.slice(0, 250),
        parent_type: 'explorer',
        parent_node: options.parentFolderToken,
        size: options.data.byteLength,
        file: Buffer.from(options.data),
      },
    }),
  );
  return extractUploadFileToken(response, 'Upload drive file');
}

export async function ensureDriveTabularFile(
  client: FeishuClient,
  options: {
    parentFolderToken: string;
    fileName: string;
    data: Uint8Array;
    existing?: NodeRef;
  },
): Promise<NodeRef> {
  const existingTokens = new Set<string>();
  if (options.existing?.token) {
    existingTokens.add(options.existing.token);
  }

  const matched = await findDriveChildByName(
    client,
    options.parentFolderToken,
    options.fileName,
  );
  if (matched?.token) {
    existingTokens.add(matched.token);
  }

  for (const token of existingTokens) {
    await deleteDriveFile(client, { fileToken: token, type: 'file' });
  }

  const fileToken = await uploadDriveFile(client, {
    parentFolderToken: options.parentFolderToken,
    fileName: options.fileName,
    data: options.data,
  });

  return {
    token: fileToken,
    nodeType: 'file',
    title: options.fileName,
  };
}

export { replaceDocumentMarkdown };
