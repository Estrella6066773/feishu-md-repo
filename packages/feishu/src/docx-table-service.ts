import type { FeishuClient } from './client.js';
import { createLogger, normalizeTableRows } from '@feishu-md/shared';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
import {
  insertDocumentBlockChildrenAt,
  insertPlainTextBlockAt,
  listDocumentBlocks,
} from './docx-block-service.js';
import { insertMarkdownIntoTableCell, clearTableCellMarkdownCache } from './table-cell-markdown.js';

const docxTableLog = createLogger('docx-table');

const DOCX_TABLE_BLOCK_TYPE = 31;
/** 飞书「创建块」接口建表时 row_size / column_size 的上限 */
const CREATE_BLOCK_TABLE_LIMIT = 9;

type CreatedTableBlock = {
  block_id?: string;
  block_type?: number;
  children?: string[];
  table?: {
    cells?: string[];
    property?: { row_size?: number; column_size?: number };
  };
};

function collectTableCellIds(tableBlock: CreatedTableBlock | undefined): string[] {
  if (!tableBlock) return [];
  if (tableBlock.children?.length) return tableBlock.children;
  return tableBlock.table?.cells ?? [];
}

async function patchInsertTableRow(
  client: FeishuClient,
  documentId: string,
  tableBlockId: string,
): Promise<void> {
  const response = await withRateLimit(() =>
    client.docx.v1.documentBlock.patch({
      path: {
        document_id: documentId,
        block_id: tableBlockId,
      },
      data: {
        insert_table_row: {
          row_index: -1,
        },
      },
    }),
  );
  assertFeishuResponse(response, 'Insert table row');
}

async function patchInsertTableColumn(
  client: FeishuClient,
  documentId: string,
  tableBlockId: string,
): Promise<void> {
  const response = await withRateLimit(() =>
    client.docx.v1.documentBlock.patch({
      path: {
        document_id: documentId,
        block_id: tableBlockId,
      },
      data: {
        insert_table_column: {
          column_index: -1,
        },
      },
    }),
  );
  assertFeishuResponse(response, 'Insert table column');
}

async function expandTableToSize(
  client: FeishuClient,
  documentId: string,
  tableBlockId: string,
  rowCount: number,
  columnCount: number,
  initialRows: number,
  initialColumns: number,
): Promise<void> {
  for (let columnIndex = initialColumns; columnIndex < columnCount; columnIndex += 1) {
    await patchInsertTableColumn(client, documentId, tableBlockId);
  }
  for (let rowIndex = initialRows; rowIndex < rowCount; rowIndex += 1) {
    await patchInsertTableRow(client, documentId, tableBlockId);
  }
}

async function listTableCellIds(
  client: FeishuClient,
  documentId: string,
  tableBlockId: string,
): Promise<string[]> {
  const items = await listDocumentBlocks(client, documentId, 'List table cell blocks');
  const tableBlock = items.find((item) => item.block_id === tableBlockId);
  const cellIds = tableBlock?.children ?? [];
  if (cellIds.length === 0) {
    throw new FeishuApiError(`Table block ${tableBlockId} has no cell children`);
  }
  return cellIds;
}

async function fillTableCells(
  client: FeishuClient,
  documentId: string,
  normalized: string[][],
  cellIds: string[],
  columnCount: number,
): Promise<void> {
  const expectedCells = normalized.length * columnCount;
  if (cellIds.length !== expectedCells) {
    throw new FeishuApiError(
      `CSV table cell count mismatch: expected ${expectedCells}, got ${cellIds.length}`,
    );
  }

  for (let cellIndex = 0; cellIndex < cellIds.length; cellIndex += 1) {
    const rowIndex = Math.floor(cellIndex / columnCount);
    const columnIndex = cellIndex % columnCount;
    const content = normalized[rowIndex]![columnIndex]!;

    await insertMarkdownIntoTableCell(
      client,
      documentId,
      cellIds[cellIndex]!,
      content,
    );
  }
}

/**
 * 在飞书云文档中插入原生表格（block_type 31），并按行列填入数据。
 * 创建块接口单次最多 9×9；超出部分通过 insert_table_row / insert_table_column 追加。
 */
export async function insertNativeTableAt(
  client: FeishuClient,
  documentId: string,
  rows: string[][],
  index: number,
): Promise<number> {
  const normalized = normalizeTableRows(rows);
  if (normalized.length === 0) {
    await insertPlainTextBlockAt(client, documentId, '（空表格）', index);
    return 1;
  }

  const rowCount = normalized.length;
  const columnCount = normalized[0]!.length;
  docxTableLog.info('插入原生表格', { documentId, rowCount, columnCount, index });
  const initialRows = Math.min(rowCount, CREATE_BLOCK_TABLE_LIMIT);
  const initialColumns = Math.min(columnCount, CREATE_BLOCK_TABLE_LIMIT);

  const createResponse = await insertDocumentBlockChildrenAt(
    client,
    documentId,
    index,
    [
      {
        block_type: DOCX_TABLE_BLOCK_TYPE,
        table: {
          property: {
            row_size: initialRows,
            column_size: initialColumns,
            header_row: rowCount > 1,
          },
        },
      },
    ],
    'Create CSV table skeleton',
  );

  const tableBlock = (createResponse.data?.children ?? [])[0] as CreatedTableBlock | undefined;
  const tableBlockId = tableBlock?.block_id;
  if (!tableBlockId) {
    throw new FeishuApiError('Create CSV table returned empty table block_id');
  }

  if (rowCount > initialRows || columnCount > initialColumns) {
    await expandTableToSize(
      client,
      documentId,
      tableBlockId,
      rowCount,
      columnCount,
      initialRows,
      initialColumns,
    );
  }

  const cellIds =
    rowCount === initialRows && columnCount === initialColumns
      ? collectTableCellIds(tableBlock)
      : await listTableCellIds(client, documentId, tableBlockId);

  await fillTableCells(client, documentId, normalized, cellIds, columnCount);
  clearTableCellMarkdownCache();

  return 1;
}

/** @deprecated 请改用 insertNativeTableAt */
export const insertCsvTableAt = insertNativeTableAt;
