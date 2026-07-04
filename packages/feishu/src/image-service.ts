import { extname } from 'node:path';
import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, formatFeishuErrorMessage, withRateLimit } from './api-error.js';
import {
  collectImageBlockIdsFromConvertBlocks,
  collectImageBlockIdsInRange,
  getChildBlockAtIndex,
  insertDocumentBlockChildrenAt,
  listDocumentBlocks,
  mapTemporaryBlockIdsToReal,
  type BlockIdRelation,
  type ConvertBlockLike,
} from './docx-block-service.js';
import { extractMarkdownImageRefs } from './markdown-images.js';
import { formatSyncLog, type SyncLogContext } from './sync-log.js';

const IMAGE_BLOCK_TYPE = 27;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

type FeishuUploadResponse = { code?: number; msg?: string; data?: { file_token?: string } };

export interface DocxImagePayload {
  data: Uint8Array;
  fileName: string;
}

export type DocxImageResolver = (
  src: string,
  alt: string,
) => Promise<DocxImagePayload | null>;

/** 飞书 upload_all 要求 file_name 简洁；中文名可能导致 multipart 校验失败 */
export function toDocxImageUploadFileName(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  const safeExt = ALLOWED_IMAGE_EXTENSIONS.has(ext) ? ext : '.png';
  return `image${safeExt}`;
}

function extractUploadFileToken(response: unknown, action: string): string {
  const payload = response as FeishuUploadResponse | null;
  if (!payload) {
    throw new FeishuApiError(`${action} returned empty response`);
  }
  if (payload.code != null && payload.code !== 0) {
    throw new FeishuApiError(`${action} failed: ${payload.msg ?? 'unknown error'}`, payload.code);
  }

  // Lark SDK uploadAll 可能返回完整 envelope，也可能只返回 data 层 { file_token }
  const token =
    payload.data?.file_token
    ?? (payload as { file_token?: string }).file_token;
  if (!token) {
    throw new FeishuApiError(`${action} returned empty file_token`);
  }
  return token;
}

/** 在文档指定位置创建空 Image Block，返回 block_id */
export async function createEmptyImageBlockAt(
  client: FeishuClient,
  documentId: string,
  index: number,
): Promise<string> {
  const createResponse = await insertDocumentBlockChildrenAt(
    client,
    documentId,
    index,
    [
      {
        block_type: IMAGE_BLOCK_TYPE,
        image: {},
      },
    ],
    'Insert image block',
  );

  const imageBlockId =
    createResponse.data?.children?.[0]?.block_id
    ?? (await resolveImageBlockIdAtIndex(client, documentId, index));
  if (!imageBlockId) {
    throw new FeishuApiError('Insert image block returned empty block_id');
  }
  return imageBlockId;
}

async function resolveImageBlockIdAtIndex(
  client: FeishuClient,
  documentId: string,
  index: number,
): Promise<string | null> {
  const block = await getChildBlockAtIndex(client, documentId, index, {
    blockType: IMAGE_BLOCK_TYPE,
    action: 'List docx blocks for image index',
  });
  return block?.block_id ?? null;
}

/**
 * 飞书官方流程：从 Git 读取二进制 → docx_image upload_all → replace_image。
 * @see https://open.feishu.cn/document/docs/docs/faq 如何插入图片
 */
export async function uploadAndBindDocxImageBlock(
  client: FeishuClient,
  documentId: string,
  imageBlockId: string,
  options: DocxImagePayload,
  context?: SyncLogContext,
): Promise<void> {
  if (!options.data || options.data.byteLength === 0) {
    throw new FeishuApiError('Docx image payload has no binary data');
  }

  const uploadFileName = toDocxImageUploadFileName(options.fileName);
  const fileBuffer = Buffer.from(options.data);

  const uploadResponse = await withRateLimit(() =>
    client.drive.v1.media.uploadAll({
      data: {
        file_name: uploadFileName,
        parent_type: 'docx_image',
        parent_node: imageBlockId,
        size: fileBuffer.byteLength,
        file: fileBuffer,
        extra: JSON.stringify({ drive_route_token: documentId }),
      },
    }),
  );
  const fileToken = extractUploadFileToken(uploadResponse, 'Upload docx image media');

  await replaceDocxImageToken(client, documentId, imageBlockId, fileToken, context);
}

/** 插入 convert 块后，解析 Image Block 的真实 block_id（优先 block_id_relations） */
export async function resolveImageBlockIdsAfterConvertInsert(
  client: FeishuClient,
  documentId: string,
  options: {
    convertBlocks: ConvertBlockLike[];
    firstLevelBlockIds: string[];
    blockIdRelations: BlockIdRelation[];
    insertIndex: number;
    insertedTopLevelCount: number;
  },
): Promise<string[]> {
  const tempImageIds = collectImageBlockIdsFromConvertBlocks(
    options.convertBlocks,
    options.firstLevelBlockIds,
    IMAGE_BLOCK_TYPE,
  );
  const mapped = mapTemporaryBlockIdsToReal(tempImageIds, options.blockIdRelations);
  if (mapped.length > 0) {
    return mapped;
  }

  const items = await listDocumentBlocks(client, documentId, 'List docx blocks for image bind');
  return collectImageBlockIdsInRange(
    items,
    documentId,
    options.insertIndex,
    options.insertedTopLevelCount,
    IMAGE_BLOCK_TYPE,
  );
}

async function replaceDocxImageToken(
  client: FeishuClient,
  documentId: string,
  imageBlockId: string,
  fileToken: string,
  context?: SyncLogContext,
): Promise<void> {
  try {
    const patchResponse = await withRateLimit(() =>
      client.docx.v1.documentBlock.patch({
        path: {
          document_id: documentId,
          block_id: imageBlockId,
        },
        data: {
          replace_image: {
            token: fileToken,
          },
        },
      }),
    );
    assertFeishuResponse(patchResponse, 'Bind docx image block');
    return;
  } catch (patchError) {
    const bindResponse = await withRateLimit(() =>
      client.docx.v1.documentBlock.batchUpdate({
        path: { document_id: documentId },
        data: {
          requests: [
            {
              block_id: imageBlockId,
              replace_image: {
                token: fileToken,
              },
            },
          ],
        },
      }),
    );
    assertFeishuResponse(bindResponse, 'Bind docx image block');
    if (patchError instanceof FeishuApiError) {
      console.warn(formatSyncLog(
        `replace_image patch 失败，已改用 batchUpdate: ${patchError.message}`,
        context,
      ));
    }
  }
}

/**
 * 飞书 FAQ：convert 插入 Image Block 后，逐张 upload_all + replace_image。
 * 须用插入后文档中的真实 block_id（convert 临时 id 不能作为 parent_node）。
 * 上传失败时保留 convert 生成的空图片块，不降级为纯文本。
 */
export async function bindConvertedImageBlocks(
  client: FeishuClient,
  documentId: string,
  imageBlockIds: string[],
  markdown: string,
  resolveImage: DocxImageResolver,
  context?: SyncLogContext,
): Promise<void> {
  const imageRefs = extractMarkdownImageRefs(markdown);
  if (imageRefs.length === 0) return;
  if (imageBlockIds.length === 0) {
    console.warn(formatSyncLog('Markdown 含图片但插入后未找到 Image Block', context));
    return;
  }

  if (imageBlockIds.length !== imageRefs.length) {
    console.warn(formatSyncLog(
      `图片块数量(${imageBlockIds.length})与 Markdown 引用(${imageRefs.length})不一致，按顺序对齐前 ${Math.min(imageBlockIds.length, imageRefs.length)} 张`,
      context,
    ));
  }

  const pairCount = Math.min(imageBlockIds.length, imageRefs.length);
  for (let i = 0; i < pairCount; i += 1) {
    const ref = imageRefs[i]!;
    const blockId = imageBlockIds[i]!;
    const itemContext: SyncLogContext = { ...context, imageSrc: ref.src };
    try {
      const resolved = await resolveImage(ref.src, ref.alt);
      if (!resolved) {
        console.warn(formatSyncLog('图片无法解析，保留空图片块', itemContext));
        continue;
      }
      await uploadAndBindDocxImageBlock(client, documentId, blockId, resolved, itemContext);
    } catch (error) {
      console.warn(formatSyncLog(
        `图片上传失败，保留空图片块: ${formatFeishuErrorMessage(error)}`,
        itemContext,
      ));
    }
  }
}

/** 创建 Image Block、上传并绑定，返回 block_id（便于失败时清理） */
export async function insertDocxImageAt(
  client: FeishuClient,
  documentId: string,
  index: number,
  options: DocxImagePayload,
  context?: SyncLogContext,
): Promise<string> {
  const imageBlockId = await createEmptyImageBlockAt(client, documentId, index);
  await uploadAndBindDocxImageBlock(client, documentId, imageBlockId, options, context);
  return imageBlockId;
}

/** 创建空 Image Block 后按官方流程上传并绑定（用于逐段插入） */
export async function insertImageBlock(
  client: FeishuClient,
  documentId: string,
  index: number,
  options: DocxImagePayload,
): Promise<number> {
  await insertDocxImageAt(client, documentId, index, options);
  return 1;
}

/** @deprecated 使用 deleteDocumentBlockById */
export { deleteDocumentBlockById, deleteDocumentBlockById as deleteImageBlockById } from './docx-block-service.js';
