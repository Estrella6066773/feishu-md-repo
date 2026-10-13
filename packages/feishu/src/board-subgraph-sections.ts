import { Graph, layout as dagreLayout } from '@dagrejs/dagre';
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre';
import type { FeishuClient } from './client.js';
import { createLogger, parseMermaidClassStyles, type DiagramNodeStyle } from '@feishu-md/shared';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
import { planSharedVerticalBuses, type ConnectorElbowSample } from './board-connector-elbows.js';
import {
  parseMermaidGraph,
  type ParsedMermaidEdge,
  type ParsedMermaidSubgraph,
} from './mermaid-subgraph.js';

const syncLog = createLogger('sync');

type UnknownRecord = Record<string, unknown>;

type FeishuOpenResponse = { code?: number; msg?: string; data?: unknown };

type RequestableClient = FeishuClient & {
  request: (payload: {
    method: string;
    url: string;
    data?: unknown;
  }) => Promise<FeishuOpenResponse>;
};

interface BoardNodeRecord {
  id?: string;
  type?: string;
  parent_id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  z_index?: number;
  angle?: number;
  text?: UnknownRecord;
  section?: UnknownRecord;
  connector?: UnknownRecord;
  composite_shape?: UnknownRecord;
  style?: UnknownRecord;
  children?: string[];
}

const SECTION_PADDING = 28;
const SECTION_TITLE_HEIGHT = 36;
const SECTION_MIN_WIDTH = 220;
const SECTION_MIN_HEIGHT = 160;
const LAYOUT_GRID_SIZE = 8;
const SECTION_GAP_X = 180;
const SECTION_GAP_Y = 120;
const LAYOUT_ASPECT_WIDTH = 16;
const LAYOUT_ASPECT_HEIGHT = 9;
/**
 * 与 Mermaid 流程图默认的 nodeSpacing / rankSpacing 相同。
 * Dagre 用它们做同层间距和层与层的间距；GitHub 上的流程图就是这组默认值。
 */
const MERMAID_NODE_SPACING = 50;
const MERMAID_RANK_SPACING = 50;
const WHITEBOARD_RETRY_DELAYS_MS = [800, 1200, 2000, 3000, 4000];
const FEISHU_COORD_LIMIT = 132070;
const FEISHU_Z_INDEX_LIMIT = 10000;

function clampFeishuCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(FEISHU_COORD_LIMIT, Math.max(-FEISHU_COORD_LIMIT, value));
}

function clampFeishuSize(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(FEISHU_COORD_LIMIT, value);
}

function clampFeishuZIndex(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(FEISHU_Z_INDEX_LIMIT, Math.max(0, Math.round(value)));
}

/** 飞书 text_color 只接受 #rrggbb，多一位或少一位会让整批创建返回 2890002。 */
function feishuHexColor(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^#([0-9a-fA-F]{6})$/);
  return match ? `#${match[1]!.toLowerCase()}` : undefined;
}
const SECTION_Z_INDEX_BASE = 100;
const CONNECTOR_Z_INDEX = 9000;
const BLOCK_Z_INDEX_BASE = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWhiteboardNotReadyError(error: unknown): boolean {
  if (!(error instanceof FeishuApiError)) return false;
  if (error.code === 4003101) return true;
  return error.message.includes('doc is applying') || error.message.includes('doc data is not ready');
}

async function withWhiteboardRetry<T>(
  action: string,
  task: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= WHITEBOARD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isWhiteboardNotReadyError(error) || attempt >= WHITEBOARD_RETRY_DELAYS_MS.length) {
        throw error;
      }
      syncLog.warn(`${action} 画板未就绪，${WHITEBOARD_RETRY_DELAYS_MS[attempt]!}ms 后重试 (${attempt + 1}/${WHITEBOARD_RETRY_DELAYS_MS.length})`);
      await sleep(WHITEBOARD_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${action} failed after retries`);
}

async function listBoardNodes(client: FeishuClient, whiteboardId: string): Promise<BoardNodeRecord[]> {
  return withWhiteboardRetry('List board nodes for subgraph sections', async () => {
    const response = await withRateLimit(
      () =>
        client.board.v1.whiteboardNode.list({
          path: { whiteboard_id: whiteboardId },
        }),
      { read: true },
    );
    assertFeishuResponse(response, 'List board nodes for subgraph sections');
    return (response.data as { nodes?: BoardNodeRecord[] } | undefined)?.nodes ?? [];
  });
}

async function batchDeleteNodes(
  client: FeishuClient,
  whiteboardId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;

  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    await withWhiteboardRetry('Delete board nodes for subgraph sections', async () => {
      const response = await withRateLimit(() =>
        (client as RequestableClient).request({
          method: 'DELETE',
          url: `/open-apis/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes/batch_delete`,
          data: { ids: chunk },
        }),
      );
      assertFeishuResponse(response, 'Delete board nodes for subgraph sections');
    });
  }
}

async function createBoardNodes(
  client: FeishuClient,
  whiteboardId: string,
  nodes: UnknownRecord[],
): Promise<string[]> {
  if (nodes.length === 0) return [];

  return withWhiteboardRetry('Create board section nodes', async () => {
    const response = await withRateLimit(() =>
      client.board.v1.whiteboardNode.create({
        path: { whiteboard_id: whiteboardId },
        data: { nodes: nodes as never },
      }),
    );
    assertFeishuResponse(response, 'Create board section nodes');
    const ids = (response.data as { ids?: string[] } | undefined)?.ids ?? [];
    return ids.map((id) => String(id));
  });
}

function readPointList(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) => {
    const record = point as UnknownRecord;
    const x = Number(record.x);
    const y = Number(record.y);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
}

/** 列出的连线端点已经是飞书分配的 id，分组必须用它，不能用提交时的自定义 id。 */
function readAttachedObjectId(endpoint: unknown, legacy: unknown): string {
  const attached = (endpoint as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined;
  if (typeof attached?.id === 'string' && attached.id) return attached.id;
  const legacyRecord = legacy as UnknownRecord | undefined;
  return typeof legacyRecord?.id === 'string' ? legacyRecord.id : '';
}

function readStartObjectId(connector: UnknownRecord | undefined): string {
  return readAttachedObjectId(connector?.start, connector?.start_object);
}

function readEndObjectId(connector: UnknownRecord | undefined): string {
  return readAttachedObjectId(connector?.end, connector?.end_object);
}

/**
 * 连线左上角从所属分区一路加到画板坐标。
 * 嵌套分区里的子线和跨分区的子线才能放进同一组共用竖线。
 */
function absoluteBoardOrigin(
  node: BoardNodeRecord,
  byId: Map<string, BoardNodeRecord>,
): { x: number; y: number } {
  let x = Number(node.x ?? 0);
  let y = Number(node.y ?? 0);
  const seen = new Set<string>();
  let parentId = node.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += Number(parent.x ?? 0);
    y += Number(parent.y ?? 0);
    parentId = parent.parent_id;
  }
  return { x, y };
}

function absoluteRect(
  node: BoardNodeRecord,
  byId: Map<string, BoardNodeRecord>,
): { x: number; y: number; right: number; bottom: number; centerY: number } {
  const origin = absoluteBoardOrigin(node, byId);
  const width = Number(node.width ?? 0);
  const height = Number(node.height ?? 0);
  return {
    x: origin.x,
    y: origin.y,
    right: origin.x + width,
    bottom: origin.y + height,
    centerY: origin.y + height / 2,
  };
}

/**
 * 用两端图形的右缘和左缘定包围盒，不沿用飞书已经拐出去的折线框。
 * 这样击魄到三个系统的竖线会贴在击魄右侧，而不会被拉到任务系统那一条干线上。
 */
function routeSample(
  payloadIndex: number,
  live: BoardNodeRecord,
  byId: Map<string, BoardNodeRecord>,
): ConnectorElbowSample | null {
  const connector = live.connector;
  const startId = readStartObjectId(connector);
  const endId = readEndObjectId(connector);
  const start = startId ? byId.get(startId) : undefined;
  const end = endId ? byId.get(endId) : undefined;
  if (!startId || !start || !end) return null;

  const startRect = absoluteRect(start, byId);
  const endRect = absoluteRect(end, byId);
  const boxWidth = endRect.x - startRect.right;
  const boxHeight = Math.abs(endRect.centerY - startRect.centerY);
  const sourceAbove = startRect.centerY <= endRect.centerY;
  return {
    payloadIndex,
    groupKey: startId,
    boxX: startRect.right,
    boxY: Math.min(startRect.centerY, endRect.centerY),
    boxWidth,
    boxHeight,
    turningPoints: boxHeight <= 0.5
      ? []
      : [
          { x: 0, y: sourceAbove ? 0 : boxHeight },
          { x: 0, y: sourceAbove ? boxHeight : 0 },
        ],
  };
}

/**
 * 飞书 Mermaid 导入的普通流程图没有走按源码的那一次创建，线上已经是飞书自己拐的。
 * 这里删掉要改的线，再用两端的真实 id 建回来。不挂 parent_id。
 * 分区连线若引用已经存在的分区，飞书会报 2890002。按源码绘制的路径不要走这里。
 *
 * 联动：applyMermaidSubgraphSections 在没有 subgraph、或分区规划失败时调用。
 * 击魄到舰只能力系统、任务系统、战役系统会共用击魄右侧的一条竖线；
 * 任务系统自己的子线在它右侧另起一条，两条平行且不重合。
 *
 * 注意：画板节点没有更新接口。PUT 会返回成功，但拐点不变。
 * 所以这条兜底只能整段删掉再创建；创建失败时把原来的线写回去。
 */
export async function alignImportedConnectorBuses(
  client: FeishuClient,
  whiteboardId: string,
): Promise<void> {
  let listed: BoardNodeRecord[];
  try {
    listed = await listBoardNodes(client, whiteboardId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncLog.warn('连线拐点读回失败，保留飞书自动折线', { whiteboardId, message });
    return;
  }

  const byId = new Map(listed.flatMap((node) => (node.id ? [[node.id, node] as const] : [])));
  const connectors = listed.filter((node) => node.type === 'connector' && node.id);
  const samples: ConnectorElbowSample[] = [];
  connectors.forEach((live, index) => {
    const sample = routeSample(index, live, byId);
    if (sample) samples.push(sample);
  });

  const snaps = planSharedVerticalBuses(samples);
  if (snaps.size === 0) return;

  const replacements: UnknownRecord[] = [];
  const restore: UnknownRecord[] = [];
  const deleteIds: string[] = [];
  for (const [index, snap] of snaps) {
    const live = connectors[index];
    if (!live?.id || !live.connector) continue;
    const origin = absoluteBoardOrigin(live, byId);
    deleteIds.push(live.id);
    replacements.push({
      id: `bus${replacements.length + 1}`,
      type: 'connector',
      x: snap.boxX,
      y: snap.boxY,
      width: snap.boxWidth,
      height: snap.boxHeight,
      angle: 0,
      style: live.style,
      z_index: live.z_index ?? 1,
      connector: {
        ...live.connector,
        shape: 'polyline',
        specified_coordinate: true,
        turning_points: snap.turningPoints,
      },
    });
    restore.push({
      id: `keep${restore.length + 1}`,
      type: 'connector',
      x: origin.x,
      y: origin.y,
      width: Number(live.width ?? 0),
      height: Number(live.height ?? 0),
      angle: 0,
      style: live.style,
      z_index: live.z_index ?? 1,
      connector: live.connector,
    });
  }

  if (deleteIds.length === 0) return;

  syncLog.debug('按共用竖线理顺导入流程图', {
    whiteboardId,
    snappedCount: deleteIds.length,
  });

  try {
    await batchDeleteNodes(client, whiteboardId, deleteIds);
    try {
      await createBoardNodes(client, whiteboardId, replacements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      syncLog.warn('导入流程图理线失败，改回原来的折线', { whiteboardId, message });
      await createBoardNodes(client, whiteboardId, restore);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncLog.warn('导入流程图理线中断，画板可能仍是飞书原来的折线', { whiteboardId, message });
  }
}

/**
 * 导入前会把标签里的尖括号、不等号换成飞书能吃的写法。
 * 分区重建拿原文标签去对画板上的文字，两边都先收成同一种写法，否则对不上、分不出区。
 */
function comparableLabel(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[＜＞]/g, (ch) => (ch === '＜' ? '<' : '>'))
    .replace(/\u2212/g, '-')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u00d7/g, 'x')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeText(node: BoardNodeRecord): string {
  const plain = node.text?.text;
  if (typeof plain === 'string' && plain.trim()) {
    return plain.trim();
  }

  const rich = node.text?.rich_text as UnknownRecord | undefined;
  const paragraphs = rich?.paragraphs as UnknownRecord[] | undefined;
  if (!paragraphs?.length) return '';

  const parts: string[] = [];
  for (const paragraph of paragraphs) {
    const elements = paragraph.elements as UnknownRecord[] | undefined;
    for (const element of elements ?? []) {
      const content = (element.text_run as UnknownRecord | undefined)?.content;
      if (typeof content === 'string' && content.trim()) {
        parts.push(content.trim());
      }
    }
  }

  return parts.join('\n').trim();
}

function fillColor(node: BoardNodeRecord): string {
  const value = node.style?.fill_color;
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isMermaidSubgraphFrameShape(
  node: BoardNodeRecord,
  subgraphTitles: Set<string>,
): boolean {
  return (
    node.type === 'composite_shape' &&
    Boolean(node.id) &&
    !node.parent_id &&
    subgraphTitles.has(comparableLabel(nodeText(node))) &&
    fillColor(node) === '#ffffde'
  );
}

function shapeTextPayload(shape: BoardNodeRecord, style?: DiagramNodeStyle): UnknownRecord {
  const label = nodeText(shape);
  const text: UnknownRecord = {
    text: label.slice(0, 1024) || ' ',
    // 不写对齐时飞书把字放在左上角，菱形和长标签会画出格子。
    horizontal_align: 'center',
    vertical_align: 'mid',
    font_size: 14,
  };
  const textColor = feishuHexColor(style?.text);
  if (textColor) {
    text.text_color = textColor;
    text.text_color_type = 1;
  }
  return text;
}

/** 与 board-legend-colors 的上色字段一致。分区重建和事后上色必须写成同一套，逆向才认得出 class。 */
function explicitShapeStyle(style: DiagramNodeStyle): UnknownRecord {
  const fill = feishuHexColor(style.fill) ?? '#f5f6f7';
  const border = feishuHexColor(style.border) ?? fill;
  return {
    fill_color: fill,
    fill_color_type: 1,
    fill_opacity: 100,
    border_width: 'narrow',
    border_opacity: 100,
    border_style: 'solid',
    border_color: border,
    border_color_type: 1,
    theme_fill_color_code: -1,
    theme_border_color_code: -1,
  };
}

/**
 * 画板节点 id 用 Mermaid 节点 id，逆向导出才能写回 `class cQFuel cond`。
 * 飞书 id 最长 100，且只保证字母数字下划线；不合法时退回 `sg1:2` 这种分区序号。
 */
function preferMermaidNodeId(mermaidId: string, fallback: string): string {
  if (/^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(mermaidId)) return mermaidId;
  return fallback;
}

function snapFloor(value: number): number {
  return Math.floor(value / LAYOUT_GRID_SIZE) * LAYOUT_GRID_SIZE;
}

function snapCeil(value: number): number {
  return Math.ceil(value / LAYOUT_GRID_SIZE) * LAYOUT_GRID_SIZE;
}

function computeSectionBounds(nodes: BoardNodeRecord[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (nodes.length === 0) return null;

  const xs = nodes.map((node) => Number(node.x ?? 0));
  const ys = nodes.map((node) => Number(node.y ?? 0));
  const ws = nodes.map((node) => Number(node.width ?? 0));
  const hs = nodes.map((node) => Number(node.height ?? 0));

  const rawX = Math.min(...xs) - SECTION_PADDING;
  const rawY = Math.min(...ys) - SECTION_PADDING - SECTION_TITLE_HEIGHT;
  const rawRight = Math.max(...xs.map((value, index) => value + ws[index]!)) + SECTION_PADDING;
  const rawBottom = Math.max(...ys.map((value, index) => value + hs[index]!)) + SECTION_PADDING;

  const x = snapFloor(rawX);
  const y = snapFloor(rawY);
  const width = Math.max(SECTION_MIN_WIDTH, snapCeil(rawRight) - x);
  const height = Math.max(SECTION_MIN_HEIGHT, snapCeil(rawBottom) - y);

  return { x, y, width, height };
}

function computeBoundsFromRects(
  rects: Array<{ x?: number; y?: number; width?: number; height?: number }>,
): { x: number; y: number; width: number; height: number } | null {
  if (rects.length === 0) return null;

  const xs = rects.map((rect) => Number(rect.x ?? 0));
  const ys = rects.map((rect) => Number(rect.y ?? 0));
  const ws = rects.map((rect) => Number(rect.width ?? 0));
  const hs = rects.map((rect) => Number(rect.height ?? 0));
  const rawX = Math.min(...xs) - SECTION_PADDING;
  const rawY = Math.min(...ys) - SECTION_PADDING - SECTION_TITLE_HEIGHT;
  const rawRight = Math.max(...xs.map((value, index) => value + ws[index]!)) + SECTION_PADDING;
  const rawBottom = Math.max(...ys.map((value, index) => value + hs[index]!)) + SECTION_PADDING;
  const x = snapFloor(rawX);
  const y = snapFloor(rawY);
  return {
    x,
    y,
    width: Math.max(SECTION_MIN_WIDTH, snapCeil(rawRight) - x),
    height: Math.max(SECTION_MIN_HEIGHT, snapCeil(rawBottom) - y),
  };
}

function toRelativeCoordinate(global: number | undefined, sectionOrigin: number): number {
  return Number(global ?? 0) - sectionOrigin;
}

function buildSectionPayload(
  id: string,
  title: string,
  bounds: { x: number; y: number; width: number; height: number },
  zIndex: number,
  parent?: { id: string; origin: { x: number; y: number } },
): UnknownRecord {
  const payload: UnknownRecord = {
    id,
    type: 'section',
    x: clampFeishuCoord(parent ? toRelativeCoordinate(bounds.x, parent.origin.x) : bounds.x),
    y: clampFeishuCoord(parent ? toRelativeCoordinate(bounds.y, parent.origin.y) : bounds.y),
    width: clampFeishuSize(bounds.width),
    height: clampFeishuSize(bounds.height),
    angle: 0,
    z_index: clampFeishuZIndex(zIndex),
    style: {
      fill_color: '#f5f6f7',
      fill_opacity: 100,
      border_width: 'extra_narrow',
      border_opacity: 100,
      border_style: 'solid',
      theme_fill_color_code: -1,
      theme_border_color_code: -1,
    },
    section: { title: title.slice(0, 100) },
  };

  if (parent) {
    payload.parent_id = parent.id;
  }

  return payload;
}

function sectionZIndex(depth: number): number {
  return SECTION_Z_INDEX_BASE + depth;
}

// 这里的“块”对应飞书画板的 composite_shape，是实际承载文本的最小单位。
function compositeShapeType(block: BoardNodeRecord, shape?: 'rect' | 'diamond'): string {
  // 条件节点用流程图菱形。普通 diamond 在飞书里更像装饰图形，导出时两种都认成 {}。
  if (shape === 'diamond') return 'flow_chart_diamond';
  const current = (block.composite_shape as UnknownRecord | undefined)?.type;
  if (typeof current === 'string' && current.length > 0 && current !== 'diamond') return current;
  if (current === 'diamond') return 'flow_chart_diamond';
  return 'round_rect';
}

function buildBlockPayload(
  id: string,
  sectionId: string,
  block: BoardNodeRecord,
  zIndex: number,
  sectionOrigin: { x: number; y: number },
  style?: DiagramNodeStyle,
  shape?: 'rect' | 'diamond',
): UnknownRecord {
  const payload: UnknownRecord = {
    id,
    type: 'composite_shape',
    parent_id: sectionId,
    x: clampFeishuCoord(toRelativeCoordinate(block.x, sectionOrigin.x)),
    y: clampFeishuCoord(toRelativeCoordinate(block.y, sectionOrigin.y)),
    width: clampFeishuSize(Number(block.width ?? 120)),
    height: clampFeishuSize(Number(block.height ?? 56)),
    angle: block.angle ?? 0,
    text: shapeTextPayload(block, style),
    composite_shape: { type: compositeShapeType(block, shape) },
    z_index: clampFeishuZIndex(zIndex),
  };
  if (style) payload.style = explicitShapeStyle(style);
  return payload;
}

function buildTopLevelBlockPayload(
  id: string,
  block: BoardNodeRecord,
  zIndex: number,
  style?: DiagramNodeStyle,
  shape?: 'rect' | 'diamond',
): UnknownRecord {
  const payload: UnknownRecord = {
    id,
    type: 'composite_shape',
    x: clampFeishuCoord(Number(block.x ?? 0)),
    y: clampFeishuCoord(Number(block.y ?? 0)),
    width: clampFeishuSize(Number(block.width ?? 120)),
    height: clampFeishuSize(Number(block.height ?? 56)),
    angle: block.angle ?? 0,
    text: shapeTextPayload(block, style),
    composite_shape: { type: compositeShapeType(block, shape) },
    z_index: clampFeishuZIndex(zIndex),
  };
  if (style) payload.style = explicitShapeStyle(style);
  return payload;
}

function defaultConnectorStyle(): UnknownRecord {
  return {
    border_width: 'narrow',
    border_color: '#000000',
    border_color_type: 0,
    border_opacity: 100,
    border_style: 'solid',
    theme_border_color_code: -1,
  };
}

type SnapSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * 线一律左进右出，而且两端都钉在边的正中。
 * 多根线叠在同一点也保持居中。竖段由 plannedConnectorGeometry 在创建前写好，不沿边错开。
 */
function connectorFacingSides(): { from: SnapSide; to: SnapSide; fromAlong: number; toAlong: number } {
  return { from: 'right', to: 'left', fromAlong: 0.5, toAlong: 0.5 };
}

interface ConnectorRouteInput {
  startObjectId: string;
  start: BlockPlacement;
  end: BlockPlacement;
  /** 有分区时，包围盒要减掉这个原点，变成分区内坐标。拐点仍相对包围盒，不要再减。 */
  origin?: { x: number; y: number };
}

/**
 * 按起点把折线收成共用竖线，返回可直接写入 create 的包围盒和拐点。
 *
 * 联动：buildSectionBatch 与 buildPlainFlowchartBatch 在组 payload 之前调用。
 * 样本用形状的绝对坐标，planSharedVerticalBuses 只移动竖线的横坐标。
 * 同一起点的线共用一条竖线；竖直范围叠在一起的不同起点再往右错开。
 *
 * 注意：飞书没有改节点的接口，拐点必须在这次 create 里写全。
 * 有分区的线，x/y 要减分区原点；turning_points 相对这条线自己的框，不能减原点。
 * 高度不超过半像素的线没有竖段，写空拐点，避免飞书再拐一折。
 */
function plannedConnectorGeometry(
  drafts: ConnectorRouteInput[],
): Array<{ x: number; y: number; width: number; height: number; turningPoints: Array<{ x: number; y: number }> }> {
  const samples: ConnectorElbowSample[] = drafts.map((draft, index) => {
    const sourceRight = draft.start.x + draft.start.width;
    const targetLeft = draft.end.x;
    const sourceCenter = draft.start.y + draft.start.height / 2;
    const targetCenter = draft.end.y + draft.end.height / 2;
    const boxHeight = Math.abs(targetCenter - sourceCenter);
    const sourceAbove = sourceCenter <= targetCenter;
    return {
      payloadIndex: index,
      groupKey: draft.startObjectId,
      boxX: sourceRight,
      boxY: Math.min(sourceCenter, targetCenter),
      boxWidth: targetLeft - sourceRight,
      boxHeight,
      turningPoints:
        boxHeight <= 0.5
          ? []
          : [
              { x: 0, y: sourceAbove ? 0 : boxHeight },
              { x: 0, y: sourceAbove ? boxHeight : 0 },
            ],
    };
  });
  const snaps = planSharedVerticalBuses(samples);
  return drafts.map((draft, index) => {
    const sample = samples[index]!;
    const snap = snaps.get(index);
    // 规划结果省略「已经落在这条竖线上」的线。省略时仍要用样本自己的拐点，不能收成直线。
    const placed =
      snap ??
      (sample.boxHeight > 0.5
        ? {
            boxX: sample.boxX,
            boxY: sample.boxY,
            boxWidth: Math.max(0, sample.boxWidth),
            boxHeight: sample.boxHeight,
            turningPoints: sample.turningPoints,
          }
        : undefined);
    const origin = draft.origin ?? { x: 0, y: 0 };
    return {
      x: clampFeishuCoord((placed?.boxX ?? sample.boxX) - origin.x),
      y: clampFeishuCoord((placed?.boxY ?? sample.boxY) - origin.y),
      width: clampFeishuSize(placed?.boxWidth ?? Math.max(0, sample.boxWidth)),
      height: clampFeishuSize(placed?.boxHeight ?? 0),
      turningPoints: placed?.turningPoints ?? [],
    };
  });
}

function sidePosition(side: SnapSide, along: number): { x: number; y: number } {
  const t = along;
  if (side === 'left') return { x: 0, y: t };
  if (side === 'right') return { x: 1, y: t };
  if (side === 'top') return { x: t, y: 0 };
  return { x: t, y: 1 };
}

/**
 * start 与 start_object 都写：创建接口认 start，部分读回仍走已废弃的 start_object。
 * 两边必须是各自的对象，不能共用一份，否则改一端的边会把另一端带歪。
 */
function connectorAttachment(id: string, side: SnapSide, along: number): UnknownRecord {
  return { id, snap_to: side, position: sidePosition(side, along) };
}

/**
 * 第一次创建就把竖线写进拐点。specified_coordinate 为 true 时，飞书按这里的坐标画，不再自己拐。
 * 同分区连线仍挂 parent_id。飞书只在同一次 create 里认自定义父子，不挂的话线会脱离分区。
 * 包围盒和拐点都相对这条线的父节点；没有父节点时就是画板坐标。
 */
function buildGeneratedConnectorPayload(
  id: string,
  startObjectId: string,
  endObjectId: string,
  startSide: SnapSide,
  startAlong: number,
  endSide: SnapSide,
  endAlong: number,
  sectionId?: string,
  label?: string,
  geometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
    turningPoints: Array<{ x: number; y: number }>;
  },
): UnknownRecord {
  const payload: UnknownRecord = {
    id,
    type: 'connector',
    x: geometry?.x ?? 0,
    y: geometry?.y ?? 0,
    width: geometry?.width ?? 0,
    height: geometry?.height ?? 0,
    angle: 0,
    style: defaultConnectorStyle(),
    connector: {
      shape: 'polyline',
      specified_coordinate: geometry != null,
      ...(geometry ? { turning_points: geometry.turningPoints } : {}),
      caption_auto_direction: false,
      start: {
        arrow_style: 'none',
        attached_object: connectorAttachment(startObjectId, startSide, startAlong),
      },
      end: {
        arrow_style: 'triangle_arrow',
        attached_object: connectorAttachment(endObjectId, endSide, endAlong),
      },
      start_object: connectorAttachment(startObjectId, startSide, startAlong),
      end_object: connectorAttachment(endObjectId, endSide, endAlong),
    },
    z_index: clampFeishuZIndex(CONNECTOR_Z_INDEX),
  };

  const caption = label?.trim();
  if (caption) {
    (payload.connector as UnknownRecord).captions = {
      data: [
        {
          text: caption.slice(0, 1024),
          font_size: 14,
          horizontal_align: 'center',
          vertical_align: 'mid',
          text_color: '#1f2329',
          text_color_type: 1,
        },
      ],
    };
    (payload.connector as UnknownRecord).caption_position = 0.5;
  }

  if (sectionId) {
    payload.parent_id = sectionId;
  }

  return payload;
}

function resolveMemberLabels(
  subgraph: ParsedMermaidSubgraph,
  nodeLabels: Map<string, string>,
): string[] {
  const labels = subgraph.memberIds
    .map((memberId) => nodeLabels.get(memberId))
    .filter((label): label is string => Boolean(label?.trim()));

  return [...new Set(labels)];
}

function findSubgraphTitleShape(
  boardNodes: BoardNodeRecord[],
  subgraph: ParsedMermaidSubgraph,
  memberLabels: Set<string>,
  consumedShapeIds: Set<string>,
): BoardNodeRecord | undefined {
  return boardNodes.find(
    (node) =>
      node.type === 'composite_shape' &&
      node.id &&
      !node.parent_id &&
      !consumedShapeIds.has(node.id) &&
      comparableLabel(nodeText(node)) === comparableLabel(subgraph.title) &&
      !memberLabels.has(nodeText(node)),
  );
}

function nodeArea(node: BoardNodeRecord): number {
  return Number(node.width ?? 0) * Number(node.height ?? 0);
}

function findMemberShapeByLabel(
  boardNodes: BoardNodeRecord[],
  label: string,
  consumedShapeIds: Set<string>,
): BoardNodeRecord | undefined {
  const wanted = comparableLabel(label);
  const matches = boardNodes.filter(
    (node) =>
      node.type === 'composite_shape' &&
      node.id &&
      !node.parent_id &&
      !consumedShapeIds.has(node.id) &&
      comparableLabel(nodeText(node)) === wanted,
  );
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  const normalMatches = matches.filter((node) => fillColor(node) !== '#ffffde');
  const candidates = normalMatches.length > 0 ? normalMatches : matches;
  return [...candidates].sort((left, right) => nodeArea(left) - nodeArea(right))[0];
}

interface TreeLayoutResult {
  depthByMember: Map<string, number>;
  /** 相对分区内容区左上角的偏移，不含分区内边距和标题条。 */
  offsetByMember: Map<string, { x: number; y: number }>;
  contentWidth: number;
  contentHeight: number;
}

interface SectionBuildPlan {
  subgraph: ParsedMermaidSubgraph;
  sectionId: string;
  bounds: { x: number; y: number; width: number; height: number };
  memberIds: string[];
  memberShapes: BoardNodeRecord[];
  titleShape?: BoardNodeRecord;
  treeLayout: TreeLayoutResult;
}

interface BlockPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  depth?: number;
}

function planSubgraphSections(
  boardNodes: BoardNodeRecord[],
  subgraphs: ParsedMermaidSubgraph[],
  nodeLabels: Map<string, string>,
  edges: Array<{ from: string; to: string }>,
): SectionBuildPlan[] {
  const plans: SectionBuildPlan[] = [];
  const consumedShapeIds = new Set<string>();

  for (const [index, subgraph] of subgraphs.entries()) {
    const memberPairs: Array<{ memberId: string; shape: BoardNodeRecord }> = [];
    for (const memberId of subgraph.memberIds) {
      const label = nodeLabels.get(memberId);
      if (!label?.trim()) continue;

      const shape = findMemberShapeByLabel(boardNodes, label, consumedShapeIds);
      if (shape?.id) {
        memberPairs.push({ memberId, shape });
        // 同一文案会出现两次（例如两处「已完成」）。不立刻占住这块形状，后面的节点会拿到同一块，坐标叠在一起。
        consumedShapeIds.add(shape.id);
      }
    }

    if (memberPairs.length === 0) continue;

    const memberLabels = memberPairs.map(({ shape }) => nodeText(shape));
    const memberLabelSet = new Set(memberLabels);
    const memberIds = memberPairs.map(({ memberId }) => memberId);
    const memberShapes = memberPairs.map(({ shape }) => shape);
    const bounds = computeSectionBounds(memberShapes);
    if (!bounds) continue;

    const titleShape = findSubgraphTitleShape(boardNodes, subgraph, memberLabelSet, consumedShapeIds);
    plans.push({
      subgraph,
      sectionId: `sg${index + 1}:1`,
      bounds,
      memberIds,
      memberShapes,
      titleShape,
      treeLayout: computeTreeLayout(memberIds, memberShapes, edges),
    });

    for (const shape of memberShapes) {
      if (shape.id) consumedShapeIds.add(shape.id);
    }
  }

  return plans;
}

/**
 * 用 Dagre 的分层排版放置分区里的节点，和 GitHub 上 Mermaid `flowchart LR` 同一套算法。
 *
 * 联动：planSubgraphSections 造分区计划时调用；layoutPlanInternalBlocks 把偏移加上分区内边距写成形状坐标。
 * 连线不走 Dagre 的折点。竖线由 plannedConnectorGeometry 在创建前按共用竖线写好。
 *
 * 注意：Dagre 给出的是中心点，这里换成左上角再平移到内容区原点。只送两端都在本分区里的边。
 * 环和回边由 Dagre 的反馈边拆开后再排层，不要改回「只认第一个父节点、按源码顺序往下堆」的树，
 * 否则同一层会拆开，共享目标会被拉到较浅的父节点旁边，飞书折线就会绕远。
 * 节点和边按源码出现顺序送入，Dagre 用这个顺序做层内初始排列，再用重心法减少交叉。
 */
function computeTreeLayout(
  memberIds: string[],
  memberShapes: BoardNodeRecord[],
  edges: Array<{ from: string; to: string }>,
): TreeLayoutResult {
  const memberSet = new Set(memberIds);
  const sizeByMember = new Map<string, { width: number; height: number }>();
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ directed: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    nodesep: MERMAID_NODE_SPACING,
    ranksep: MERMAID_RANK_SPACING,
    marginx: 0,
    marginy: 0,
    ranker: 'network-simplex',
  });

  for (const [index, memberId] of memberIds.entries()) {
    const shape = memberShapes[index];
    const size = {
      width: Math.max(1, Number(shape?.width ?? 140)),
      height: Math.max(1, Number(shape?.height ?? 56)),
    };
    sizeByMember.set(memberId, size);
    graph.setNode(memberId, size);
  }

  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!memberSet.has(edge.from) || !memberSet.has(edge.to) || edge.from === edge.to) continue;
    const key = `${edge.from}\0${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    graph.setEdge(edge.from, edge.to);
  }

  dagreLayout(graph);

  const depthByMember = new Map<string, number>();
  const offsetByMember = new Map<string, { x: number; y: number }>();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  const centers: Array<{ memberId: string; x: number; y: number; rank: number }> = [];

  for (const memberId of memberIds) {
    const placed = graph.node(memberId);
    const size = sizeByMember.get(memberId)!;
    const centerX = Number(placed?.x ?? size.width / 2);
    const centerY = Number(placed?.y ?? size.height / 2);
    const x = centerX - size.width / 2;
    const y = centerY - size.height / 2;
    const rank = Number(placed?.rank ?? 0);
    centers.push({ memberId, x, y, rank });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }

  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;

  let contentWidth = 0;
  let contentHeight = 0;
  for (const center of centers) {
    const size = sizeByMember.get(center.memberId)!;
    const x = center.x - minX;
    const y = center.y - minY;
    offsetByMember.set(center.memberId, { x, y });
    depthByMember.set(center.memberId, center.rank);
    contentWidth = Math.max(contentWidth, x + size.width);
    contentHeight = Math.max(contentHeight, y + size.height);
  }

  return { depthByMember, offsetByMember, contentWidth, contentHeight };
}

function computePlanDimensions(plan: SectionBuildPlan): { width: number; height: number } {
  const { contentWidth, contentHeight } = plan.treeLayout;
  return {
    width: snapCeil(Math.max(SECTION_MIN_WIDTH, SECTION_PADDING * 2 + contentWidth)),
    height: snapCeil(
      Math.max(
        SECTION_MIN_HEIGHT,
        SECTION_TITLE_HEIGHT + SECTION_PADDING * 2 + contentHeight,
      ),
    ),
  };
}

function placeSiblingSectionGroup(
  plans: SectionBuildPlan[],
  originX: number,
  originY: number,
): void {
  if (plans.length === 0) return;

  const targetRowWidth = computeTargetRowWidth(plans);
  const rows = partitionPlansIntoRows(plans, targetRowWidth);
  let cursorY = originY;

  for (const row of rows) {
    const rowHeight = Math.max(...row.map((plan) => plan.bounds.height));
    let cursorX = originX;

    for (const plan of row) {
      plan.bounds = {
        ...plan.bounds,
        x: snapCeil(cursorX),
        y: snapCeil(cursorY + Math.max(0, (rowHeight - plan.bounds.height) / 2)),
      };
      cursorX += plan.bounds.width + SECTION_GAP_X;
    }

    cursorY += rowHeight + SECTION_GAP_Y;
  }
}

function computeTargetRowWidth(plans: SectionBuildPlan[]): number {
  const totalArea = plans.reduce((sum, plan) => sum + plan.bounds.width * plan.bounds.height, 0);
  const aspect = LAYOUT_ASPECT_WIDTH / LAYOUT_ASPECT_HEIGHT;
  return Math.sqrt(totalArea * aspect);
}

function rowWidthForRange(plans: SectionBuildPlan[], start: number, end: number): number {
  let width = 0;
  for (let index = start; index <= end; index += 1) {
    if (index > start) width += SECTION_GAP_X;
    width += plans[index]!.bounds.width;
  }
  return width;
}

function rowHeightForRange(plans: SectionBuildPlan[], start: number, end: number): number {
  let height = 0;
  for (let index = start; index <= end; index += 1) {
    height = Math.max(height, plans[index]!.bounds.height);
  }
  return height;
}

function partitionPlansIntoRows(plans: SectionBuildPlan[], targetRowWidth: number): SectionBuildPlan[][] {
  if (plans.length === 0) return [];
  if (plans.length === 1) return [plans];

  const count = plans.length;
  const dp = Array.from({ length: count + 1 }, () => Number.POSITIVE_INFINITY);
  const breakAt = Array.from({ length: count + 1 }, () => 0);
  dp[0] = 0;

  for (let end = 1; end <= count; end += 1) {
    for (let start = 0; start < end; start += 1) {
      const width = rowWidthForRange(plans, start, end - 1);
      const height = rowHeightForRange(plans, start, end - 1);
      const widthPenalty = (width - targetRowWidth) ** 2;
      const cost = dp[start]! + widthPenalty + width * height;
      if (cost < dp[end]!) {
        dp[end] = cost;
        breakAt[end] = start;
      }
    }
  }

  const rows: SectionBuildPlan[][] = [];
  let end = count;
  while (end > 0) {
    const start = breakAt[end]!;
    rows.unshift(plans.slice(start, end));
    end = start;
  }
  return rows;
}

function layoutPlanInternalBlocks(
  plan: SectionBuildPlan,
  placementByShapeId: Map<string, BlockPlacement>,
): void {
  const { depthByMember, offsetByMember } = plan.treeLayout;

  for (const [index, shape] of plan.memberShapes.entries()) {
    if (!shape.id) continue;
    const memberId = plan.memberIds[index]!;
    const depth = depthByMember.get(memberId) ?? 0;
    const offset = offsetByMember.get(memberId) ?? { x: 0, y: 0 };
    const x = plan.bounds.x + SECTION_PADDING + offset.x;
    const y = plan.bounds.y + SECTION_TITLE_HEIGHT + SECTION_PADDING + offset.y;
    shape.x = snapCeil(x);
    shape.y = snapCeil(y);
    placementByShapeId.set(String(shape.id), {
      x: Number(shape.x),
      y: Number(shape.y),
      width: Number(shape.width ?? 140),
      height: Number(shape.height ?? 56),
      depth,
    });
  }
}

function groupPlansByParentId(plans: SectionBuildPlan[]): Map<string | undefined, SectionBuildPlan[]> {
  const groups = new Map<string | undefined, SectionBuildPlan[]>();
  for (const plan of plans) {
    const parentId = plan.subgraph.parentId;
    const siblings = groups.get(parentId) ?? [];
    siblings.push(plan);
    groups.set(parentId, siblings);
  }
  return groups;
}

/** 先递归测量子分区，再按子树外包确定父分区尺寸（父子优先于同级）。 */
function measurePlanSubtree(
  plan: SectionBuildPlan,
  groupsByParent: Map<string | undefined, SectionBuildPlan[]>,
): void {
  const memberDims = computePlanDimensions(plan);
  const children = groupsByParent.get(plan.subgraph.id) ?? [];

  if (children.length === 0) {
    plan.bounds = { x: 0, y: 0, ...memberDims };
    return;
  }

  for (const child of children) {
    measurePlanSubtree(child, groupsByParent);
  }

  placeSiblingSectionGroup(
    children,
    SECTION_PADDING,
    SECTION_TITLE_HEIGHT + SECTION_PADDING,
  );

  const childBounds = computeBoundsFromRects(children.map((child) => child.bounds));
  plan.bounds = {
    x: 0,
    y: 0,
    width: snapCeil(Math.max(memberDims.width, childBounds?.width ?? 0)),
    height: snapCeil(Math.max(memberDims.height, childBounds?.height ?? 0)),
  };
}

/** 在父分区最终落位后，递归放置子分区并排版内部块。 */
function placePlanSubtree(
  plan: SectionBuildPlan,
  groupsByParent: Map<string | undefined, SectionBuildPlan[]>,
  placementByShapeId: Map<string, BlockPlacement>,
): void {
  const children = groupsByParent.get(plan.subgraph.id) ?? [];
  if (children.length > 0) {
    placeSiblingSectionGroup(
      children,
      plan.bounds.x + SECTION_PADDING,
      plan.bounds.y + SECTION_TITLE_HEIGHT + SECTION_PADDING,
    );
    for (const child of children) {
      placePlanSubtree(child, groupsByParent, placementByShapeId);
    }
  }

  layoutPlanInternalBlocks(plan, placementByShapeId);
}

function applyReadableLayout(
  plans: SectionBuildPlan[],
): Map<string, BlockPlacement> {
  const placementByShapeId = new Map<string, BlockPlacement>();
  if (plans.length === 0) return placementByShapeId;

  const allShapes = plans.flatMap((plan) => plan.memberShapes);
  const baseX = snapFloor(Math.min(...allShapes.map((shape) => Number(shape.x ?? 0))));
  const baseY = snapFloor(Math.min(...allShapes.map((shape) => Number(shape.y ?? 0))));

  const groupsByParent = groupPlansByParentId(plans);
  const roots = groupsByParent.get(undefined) ?? [];

  for (const root of roots) {
    measurePlanSubtree(root, groupsByParent);
  }

  placeSiblingSectionGroup(roots, baseX, baseY);

  for (const root of roots) {
    placePlanSubtree(root, groupsByParent, placementByShapeId);
  }

  expandParentSections(plans);
  return placementByShapeId;
}

function expandParentSections(plans: SectionBuildPlan[]): void {
  const plansByParent = new Map<string, SectionBuildPlan[]>();
  for (const plan of plans) {
    const parentId = plan.subgraph.parentId;
    if (!parentId) continue;
    const siblings = plansByParent.get(parentId) ?? [];
    siblings.push(plan);
    plansByParent.set(parentId, siblings);
  }

  const bySubgraphId = new Map(plans.map((plan) => [plan.subgraph.id, plan]));
  const sortedParents = [...plans]
    .filter((plan) => plansByParent.has(plan.subgraph.id))
    .sort((left, right) => right.subgraph.depth - left.subgraph.depth);

  for (const parent of sortedParents) {
    const children = plansByParent.get(parent.subgraph.id) ?? [];
    const rects = [
      ...parent.memberShapes,
      ...children.map((child) => child.bounds),
    ];
    const bounds = computeBoundsFromRects(rects);
    if (bounds) {
      parent.bounds = bounds;
    }

    const grandParent = parent.subgraph.parentId ? bySubgraphId.get(parent.subgraph.parentId) : undefined;
    if (grandParent) {
      const siblings = plansByParent.get(grandParent.subgraph.id) ?? [];
      if (!siblings.includes(parent)) {
        siblings.push(parent);
      }
    }
  }
}

function buildSectionBatch(
  boardNodes: BoardNodeRecord[],
  plans: SectionBuildPlan[],
  nodeLabels: Map<string, string>,
  edges: ParsedMermaidEdge[],
  styleByNodeId: Map<string, DiagramNodeStyle>,
  nodeShapes?: Map<string, 'rect' | 'diamond'>,
): { batch: UnknownRecord[]; deleteIds: string[] } {
  const placementByShapeId = applyReadableLayout(plans);
  const shapeIdMap = new Map<string, string>();
  const mermaidIdMap = new Map<string, string>();
  const mermaidSectionMap = new Map<string, SectionBuildPlan>();
  const mermaidPlacementMap = new Map<string, BlockPlacement>();
  const blockPayloads: UnknownRecord[] = [];
  const externalBlockPayloads: UnknownRecord[] = [];
  const deleteIds: string[] = [];
  const titleShapeIds = new Set<string>();
  const subgraphTitles = new Set(plans.map((plan) => comparableLabel(plan.subgraph.title)));
  const nodeLabelSet = new Set(
    [...nodeLabels.values()].map((label) => comparableLabel(label)).filter(Boolean),
  );
  const sectionConnectorCounts = new Map<string, number>();

  for (const frameShape of boardNodes.filter((node) =>
    isMermaidSubgraphFrameShape(node, subgraphTitles),
  )) {
    const id = String(frameShape.id);
    titleShapeIds.add(id);
    deleteIds.push(id);
  }

  for (const plan of plans) {
    if (plan.titleShape?.id) {
      titleShapeIds.add(String(plan.titleShape.id));
      deleteIds.push(String(plan.titleShape.id));
    }

    plan.memberShapes.forEach((shape, index) => {
      if (!shape.id) return;
      const oldId = String(shape.id);
      const memberId = plan.memberIds[index]!;
      const newId = preferMermaidNodeId(memberId, `${plan.sectionId.replace(':1', '')}:${index + 2}`);
      shapeIdMap.set(oldId, newId);
      mermaidIdMap.set(memberId, newId);
      mermaidSectionMap.set(memberId, plan);
      const placement = placementByShapeId.get(oldId);
      if (placement) {
        mermaidPlacementMap.set(memberId, placement);
      }
      deleteIds.push(oldId);
      blockPayloads.push(
        buildBlockPayload(
          newId,
          plan.sectionId,
          shape,
          BLOCK_Z_INDEX_BASE + blockPayloads.length,
          plan.bounds,
          styleByNodeId.get(memberId),
          nodeShapes?.get(memberId),
        ),
      );
    });
  }

  const mapExternalMermaidNode = (nodeId: string): boolean => {
    if (mermaidIdMap.has(nodeId)) return true;
    const label = nodeLabels.get(nodeId);
    if (!label?.trim()) return false;
    const block = boardNodes.find(
      (node) =>
        node.type === 'composite_shape' &&
        node.id &&
        !node.parent_id &&
        !titleShapeIds.has(String(node.id)) &&
        !shapeIdMap.has(String(node.id)) &&
        nodeText(node) === label.trim(),
    );
    if (!block?.id) return false;

    const newId = preferMermaidNodeId(nodeId, `sgo:${externalBlockPayloads.length + 1}`);
    block.x = snapCeil(Number(block.x ?? 0));
    block.y = snapCeil(Number(block.y ?? 0));
    const oldId = String(block.id);
    shapeIdMap.set(oldId, newId);
    mermaidIdMap.set(nodeId, newId);
    const placement = {
      x: Number(block.x ?? 0),
      y: Number(block.y ?? 0),
      width: Number(block.width ?? 120),
      height: Number(block.height ?? 56),
    };
    placementByShapeId.set(oldId, placement);
    mermaidPlacementMap.set(nodeId, placement);
    deleteIds.push(oldId);
    externalBlockPayloads.push(
      buildTopLevelBlockPayload(
        newId,
        block,
        BLOCK_Z_INDEX_BASE + blockPayloads.length + externalBlockPayloads.length,
        styleByNodeId.get(nodeId),
        nodeShapes?.get(nodeId),
      ),
    );
    return true;
  };

  for (const edge of edges) {
    mapExternalMermaidNode(edge.from);
    mapExternalMermaidNode(edge.to);
  }

  for (const conn of boardNodes) {
    if (conn.type === 'connector' && conn.id && !conn.parent_id) {
      deleteIds.push(String(conn.id));
    }
  }

  for (const node of boardNodes) {
    if (
      node.type === 'composite_shape' &&
      node.id &&
      !node.parent_id &&
      nodeLabelSet.has(comparableLabel(nodeText(node)))
    ) {
      deleteIds.push(String(node.id));
    }
  }

  const connectorDrafts: Array<{
    id: string;
    startObjectId: string;
    endObjectId: string;
    from: SnapSide;
    to: SnapSide;
    fromAlong: number;
    toAlong: number;
    sectionId?: string;
    label?: string;
    start: BlockPlacement;
    end: BlockPlacement;
    origin?: { x: number; y: number };
  }> = [];
  for (const edge of edges) {
    const startObjectId = mermaidIdMap.get(edge.from);
    const endObjectId = mermaidIdMap.get(edge.to);
    const startPlacement = mermaidPlacementMap.get(edge.from);
    const endPlacement = mermaidPlacementMap.get(edge.to);
    if (!startObjectId || !endObjectId || !startPlacement || !endPlacement) continue;

    const startSection = mermaidSectionMap.get(edge.from);
    const endSection = mermaidSectionMap.get(edge.to);
    const sameSection = startSection && endSection && startSection.sectionId === endSection.sectionId;
    const connectorId = sameSection
      ? `${startSection.sectionId.replace(':1', '')}:c${(sectionConnectorCounts.get(startSection.sectionId) ?? 0) + 1}`
      : `sgc:${connectorDrafts.length + 1}`;
    if (sameSection) {
      sectionConnectorCounts.set(
        startSection.sectionId,
        (sectionConnectorCounts.get(startSection.sectionId) ?? 0) + 1,
      );
    }

    const facing = connectorFacingSides();
    connectorDrafts.push({
      id: connectorId,
      startObjectId,
      endObjectId,
      from: facing.from,
      to: facing.to,
      fromAlong: facing.fromAlong,
      toAlong: facing.toAlong,
      sectionId: sameSection ? startSection.sectionId : undefined,
      label: edge.label,
      start: startPlacement,
      end: endPlacement,
      origin: sameSection ? { x: startSection.bounds.x, y: startSection.bounds.y } : undefined,
    });
  }

  const geometries = plannedConnectorGeometry(connectorDrafts);
  const connectorPayloads = connectorDrafts.map((draft, index) =>
    buildGeneratedConnectorPayload(
      draft.id,
      draft.startObjectId,
      draft.endObjectId,
      draft.from,
      draft.fromAlong,
      draft.to,
      draft.toAlong,
      draft.sectionId,
      draft.label,
      geometries[index],
    ),
  );

  const planBySubgraphId = new Map(plans.map((plan) => [plan.subgraph.id, plan]));
  const sectionPayloads = [...plans]
    .sort((left, right) => left.subgraph.depth - right.subgraph.depth)
    .map((plan) => {
      const parentPlan = plan.subgraph.parentId ? planBySubgraphId.get(plan.subgraph.parentId) : undefined;
      const parent = parentPlan
        ? {
            id: parentPlan.sectionId,
            origin: parentPlan.bounds,
          }
        : undefined;

    return buildSectionPayload(
      plan.sectionId,
      plan.subgraph.title,
      plan.bounds,
      sectionZIndex(plan.subgraph.depth),
      parent,
    );
    });

  return {
    batch: [...sectionPayloads, ...blockPayloads, ...connectorPayloads, ...externalBlockPayloads],
    deleteIds: [...new Set(deleteIds)],
  };
}

async function convertGroupNodesToSections(
  client: FeishuClient,
  whiteboardId: string,
  boardNodes: BoardNodeRecord[],
): Promise<void> {
  const groups = boardNodes.filter((node) => node.type === 'group' && node.id);
  if (groups.length === 0) return;

  for (const [index, group] of groups.entries()) {
    const title =
      typeof (group.section as UnknownRecord | undefined)?.title === 'string'
        ? String((group.section as UnknownRecord).title)
        : `分组 ${index + 1}`;

    const groupId = String(group.id);
    await batchDeleteNodes(client, whiteboardId, [groupId]);
    await createBoardNodes(client, whiteboardId, [
      buildSectionPayload(
        groupId,
        title,
        {
          x: Number(group.x ?? 0),
          y: Number(group.y ?? 0),
          width: Number(group.width ?? 120),
          height: Number(group.height ?? 120),
        },
        Number(group.z_index ?? 0),
      ),
    ]);
  }
}

/** 节点 id → classDef 样式。没有 class 行时为空，调用方仍走分区重建。 */
function styleByMermaidNodeId(mermaidCode: string): Map<string, DiagramNodeStyle> {
  const parsed = parseMermaidClassStyles(mermaidCode);
  const styles = new Map<string, DiagramNodeStyle>();
  for (const [nodeId, className] of parsed.classByNodeId) {
    const style = parsed.styleByClass.get(className);
    if (style) styles.set(nodeId, style);
  }
  return styles;
}

/**
 * 按标签长度估一块形状的宽高。
 * 中文按一字一格估算，避免飞书把长标签裁成一行看不全。
 * 菱形要比矩形更宽更高，文字画在菱形中间才放得下。
 */
function estimateNodeSize(label: string, diamond: boolean): { width: number; height: number } {
  const length = Array.from(label).length;
  const textWidth = Math.min(360, Math.max(96, length * 18));
  if (diamond) {
    const width = Math.max(180, textWidth + 56);
    return { width, height: Math.max(120, Math.round(width * 0.72)) };
  }
  const width = Math.max(140, textWidth + 36);
  const lines = Math.max(1, Math.ceil(length / 14));
  return { width, height: Math.max(56, 24 + lines * 22) };
}

/**
 * 用源码造一批还没落到飞书上的形状，交给和导入后同一套分区布局。
 * id 以 src: 开头，只在内存里用来对标签；真正创建时会换成 Mermaid 节点 id。
 */
function syntheticShapesFromGraph(parsed: ReturnType<typeof parseMermaidGraph>): BoardNodeRecord[] {
  const shapes: BoardNodeRecord[] = [];
  for (const [nodeId, label] of parsed.nodeLabels) {
    const diamond = parsed.nodeShapes.get(nodeId) === 'diamond';
    const size = estimateNodeSize(label, diamond);
    shapes.push({
      id: `src:${nodeId}`,
      type: 'composite_shape',
      text: { text: label },
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      composite_shape: { type: diamond ? 'flow_chart_diamond' : 'round_rect' },
    });
  }
  return shapes;
}

/**
 * 没有 subgraph 的流程图也在本地排好，一次创建形状和已经理顺的连线。
 * 不套分区框。标题若在文档标题里，不要在画板上再画一圈。
 *
 * 联动：flowchartCreateBatch 在分区规划用不上时调用。布局仍是 computeTreeLayout。
 * 连线不挂 parent_id，坐标就是画板坐标。
 */
function buildPlainFlowchartBatch(
  parsed: ReturnType<typeof parseMermaidGraph>,
  styleByNodeId: Map<string, DiagramNodeStyle>,
): UnknownRecord[] {
  const shapes = syntheticShapesFromGraph(parsed);
  const memberIds = [...parsed.nodeLabels.keys()];
  if (memberIds.length === 0) return [];

  const memberShapes = memberIds.map((memberId) => shapes.find((shape) => shape.id === `src:${memberId}`)!);
  const layout = computeTreeLayout(memberIds, memberShapes, parsed.edges);
  const placements = new Map<string, BlockPlacement>();
  const idByMember = new Map<string, string>();
  const payloads: UnknownRecord[] = [];

  memberIds.forEach((memberId, index) => {
    const offset = layout.offsetByMember.get(memberId) ?? { x: 0, y: 0 };
    const shape = memberShapes[index]!;
    const placement: BlockPlacement = {
      x: snapCeil(SECTION_PADDING + offset.x),
      y: snapCeil(SECTION_PADDING + offset.y),
      width: Number(shape.width ?? 140),
      height: Number(shape.height ?? 56),
    };
    placements.set(memberId, placement);
    const nodeId = preferMermaidNodeId(memberId, `n${index + 1}`);
    idByMember.set(memberId, nodeId);
    payloads.push(
      buildTopLevelBlockPayload(
        nodeId,
        { ...shape, x: placement.x, y: placement.y, width: placement.width, height: placement.height },
        BLOCK_Z_INDEX_BASE + index,
        styleByNodeId.get(memberId),
        parsed.nodeShapes.get(memberId),
      ),
    );
  });

  const drafts: Array<{
    id: string;
    startObjectId: string;
    endObjectId: string;
    from: SnapSide;
    to: SnapSide;
    fromAlong: number;
    toAlong: number;
    label?: string;
    start: BlockPlacement;
    end: BlockPlacement;
  }> = [];
  for (const edge of parsed.edges) {
    const start = placements.get(edge.from);
    const end = placements.get(edge.to);
    const startObjectId = idByMember.get(edge.from);
    const endObjectId = idByMember.get(edge.to);
    if (!start || !end || !startObjectId || !endObjectId || edge.from === edge.to) continue;
    const facing = connectorFacingSides();
    drafts.push({
      id: `lnk:${drafts.length + 1}`,
      startObjectId,
      endObjectId,
      from: facing.from,
      to: facing.to,
      fromAlong: facing.fromAlong,
      toAlong: facing.toAlong,
      label: edge.label,
      start,
      end,
    });
  }

  const geometries = plannedConnectorGeometry(drafts);
  drafts.forEach((draft, index) => {
    payloads.push(
      buildGeneratedConnectorPayload(
        draft.id,
        draft.startObjectId,
        draft.endObjectId,
        draft.from,
        draft.fromAlong,
        draft.to,
        draft.toAlong,
        undefined,
        draft.label,
        geometries[index],
      ),
    );
  });
  return payloads;
}

/**
 * 直接绘制会提交的那一批节点。有 subgraph 时套分区；没有时按整图画在画板根上。
 * renderMermaidFlowchartBoard 与 previewMermaidFlowchartBoard 共用，避免预览和真正创建各写一套。
 */
function flowchartCreateBatch(mermaidCode: string): UnknownRecord[] {
  const parsed = parseMermaidGraph(mermaidCode);
  if (parsed.nodeLabels.size === 0) return [];
  const styles = styleByMermaidNodeId(mermaidCode);
  if (parsed.subgraphs.length > 0) {
    const synthetic = syntheticShapesFromGraph(parsed);
    const plans = planSubgraphSections(synthetic, parsed.subgraphs, parsed.nodeLabels, parsed.edges);
    if (plans.length > 0) {
      return buildSectionBatch(
        synthetic,
        plans,
        parsed.nodeLabels,
        parsed.edges,
        styles,
        parsed.nodeShapes,
      ).batch;
    }
  }
  return buildPlainFlowchartBatch(parsed, styles);
}

/**
 * 流程图直接画到空画板上，不经过飞书 Mermaid 导入。
 *
 * 联动：docx-content 与 append-markdown 在导入前调用。返回 true 表示画板已写好，
 * 调用方不要再 importBoardMermaidDiagram，否则会把这块画板清掉。
 * 颜色、菱形、条件标签和共用竖线都写在这一次 create 里。
 *
 * 注意：没有 subgraph 的图也不再交给飞书导入，否则拐点只能事后删了重建。
 * 飞书要求分区、形状、连线在同一次 create 里才能认 parent_id，所以整图一次提交，不要拆批。
 * 节点很多时这次请求会比较大；失败应抛出，由调用方退回 Mermaid 导入。
 */
export async function renderMermaidFlowchartBoard(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
): Promise<boolean> {
  const batch = flowchartCreateBatch(mermaidCode);
  if (batch.length === 0) return false;

  const existing = await listBoardNodes(client, whiteboardId);
  const existingIds = existing.map((node) => node.id).filter((id): id is string => Boolean(id));
  await batchDeleteNodes(client, whiteboardId, existingIds);
  await createBoardNodes(client, whiteboardId, batch);
  const parsed = parseMermaidGraph(mermaidCode);
  syncLog.debug('按源码直接绘制流程图', {
    whiteboardId,
    nodeCount: parsed.nodeLabels.size,
    edgeCount: parsed.edges.length,
    createNodeCount: batch.length,
  });
  return true;
}

/**
 * 不请求飞书，把「直接绘制」会提交的节点统计出来。
 * scripts/check-flowchart-roundtrip.ts 用它核对菱形、条件标签和颜色有没有进同一批 payload。
 * 和 renderMermaidFlowchartBoard 共用 flowchartCreateBatch，改布局或拐点时两边一起变。
 */
export function previewMermaidFlowchartBoard(mermaidCode: string): {
  ok: boolean;
  sectionCount: number;
  shapeCount: number;
  diamondCount: number;
  connectorCount: number;
  /** 创建时已写好坐标的折线。应与 connectorCount 相同。 */
  autoPolylineCount: number;
  /** 从右边正中出去、从左边正中进来。 */
  rightToLeftCount: number;
  captionCount: number;
  styledCount: number;
  overlapCount: number;
  overlapSample: string[];
  /** 有竖段的连线，竖段在父节点坐标系里的横坐标。同一起点应相同。 */
  elbowXs: number[];
  /** 形状左上角坐标。检查脚本用来核对分层是否还和 Dagre 的结果一致。 */
  boxes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
} {
  const empty = {
    ok: false,
    sectionCount: 0,
    shapeCount: 0,
    diamondCount: 0,
    connectorCount: 0,
    autoPolylineCount: 0,
    rightToLeftCount: 0,
    captionCount: 0,
    styledCount: 0,
    overlapCount: 0,
    overlapSample: [] as string[],
    elbowXs: [] as number[],
    boxes: [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
  };
  const batch = flowchartCreateBatch(mermaidCode);
  if (batch.length === 0) return empty;

  let sectionCount = 0;
  let shapeCount = 0;
  let diamondCount = 0;
  let connectorCount = 0;
  let autoPolylineCount = 0;
  let rightToLeftCount = 0;
  let captionCount = 0;
  let styledCount = 0;
  const elbowXs: number[] = [];
  const shapesByParent = new Map<string, Array<{ id: string; x: number; y: number; width: number; height: number }>>();
  const boxes: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
  for (const node of batch) {
    if (node.type === 'section') sectionCount += 1;
    if (node.type === 'composite_shape') {
      shapeCount += 1;
      const shapeType = (node.composite_shape as UnknownRecord | undefined)?.type;
      if (shapeType === 'diamond' || shapeType === 'flow_chart_diamond') diamondCount += 1;
      if (node.style) styledCount += 1;
      const parentKey = typeof node.parent_id === 'string' ? node.parent_id : '';
      const box = {
        id: String(node.id ?? ''),
        x: Number(node.x ?? 0),
        y: Number(node.y ?? 0),
        width: Number(node.width ?? 0),
        height: Number(node.height ?? 0),
      };
      const group = shapesByParent.get(parentKey) ?? [];
      group.push(box);
      shapesByParent.set(parentKey, group);
      boxes.push(box);
    }
    if (node.type === 'connector') {
      connectorCount += 1;
      const connector = node.connector as UnknownRecord | undefined;
      const captions = (connector?.captions as UnknownRecord | undefined)?.data;
      if (Array.isArray(captions) && captions.length > 0) captionCount += 1;
      const startAttached = (connector?.start as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined;
      const endAttached = (connector?.end as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined;
      const startPos = startAttached?.position as UnknownRecord | undefined;
      const explicitSide = (side: unknown) => side === 'left' || side === 'right' || side === 'top' || side === 'bottom';
      if (
        connector?.shape === 'polyline' &&
        connector.specified_coordinate === true &&
        explicitSide(startAttached?.snap_to) &&
        explicitSide(endAttached?.snap_to) &&
        typeof startPos?.x === 'number' &&
        typeof startPos?.y === 'number'
      ) {
        autoPolylineCount += 1;
      }
      const turningPoints = connector?.turning_points;
      if (Array.isArray(turningPoints) && turningPoints.length >= 2) {
        const turnX = Number((turningPoints[0] as UnknownRecord | undefined)?.x);
        if (Number.isFinite(turnX)) elbowXs.push(Number(node.x ?? 0) + turnX);
      }
      const endPos = endAttached?.position as UnknownRecord | undefined;
      if (
        startAttached?.snap_to === 'right' &&
        endAttached?.snap_to === 'left' &&
        startPos?.x === 1 &&
        startPos?.y === 0.5 &&
        endPos?.x === 0 &&
        endPos?.y === 0.5
      ) {
        rightToLeftCount += 1;
      }
    }
  }

  let overlapCount = 0;
  const overlapSample: string[] = [];
  for (const group of shapesByParent.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left]!;
        const b = group[right]!;
        const separated =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        if (!separated) {
          overlapCount += 1;
          if (overlapSample.length < 6) {
            overlapSample.push(
              `${a.id}@${a.x},${a.y} ${a.width}x${a.height} ~ ${b.id}@${b.x},${b.y} ${b.width}x${b.height}`,
            );
          }
        }
      }
    }
  }

  return {
    ok: shapeCount > 0 && connectorCount > 0 && overlapCount === 0,
    sectionCount,
    shapeCount,
    diamondCount,
    connectorCount,
    autoPolylineCount,
    rightToLeftCount,
    captionCount,
    styledCount,
    overlapCount,
    overlapSample,
    elbowXs,
    boxes,
  };
}

/**
 * Mermaid 导入后，将 subgraph 重建为 native section：
 * 分区、块、线按整图同一批创建，线端点统一映射到同批 custom id。
 * 连线第一次是折线且不写拐点，折线怎么拐由飞书算；起点钉在右边正中，终点钉在左边正中。
 * 没有 subgraph 时保留飞书导入结果，再按同一起点共用竖线理一次。
 * 分区内线挂 parent_id 到分区，跨分区线保持全局线。
 * 块的 id 尽量用 Mermaid 节点 id，颜色写在同一批创建里，避免上色时再删掉已经连上的线。
 * `-->|0|` 的标签写进 connector.captions，逆向导出靠它还原条件分支。
 */
export async function applyMermaidSubgraphSections(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
): Promise<void> {
  const parsed = parseMermaidGraph(mermaidCode);
  if (parsed.subgraphs.length === 0) {
    syncLog.debug('Mermaid 无 subgraph，仅转换 group 为 section', { whiteboardId });
    const boardNodes = await listBoardNodes(client, whiteboardId);
    await convertGroupNodesToSections(client, whiteboardId, boardNodes);
    await alignImportedConnectorBuses(client, whiteboardId);
    return;
  }

  let boardNodes = await listBoardNodes(client, whiteboardId);
  const plans = planSubgraphSections(boardNodes, parsed.subgraphs, parsed.nodeLabels, parsed.edges);
  syncLog.debug('subgraph 分区规划完成', {
    whiteboardId,
    subgraphCount: parsed.subgraphs.length,
    planCount: plans.length,
    edgeCount: parsed.edges.length,
  });
  if (plans.length === 0) {
    await convertGroupNodesToSections(client, whiteboardId, boardNodes);
    await alignImportedConnectorBuses(client, whiteboardId);
    return;
  }

  const { batch, deleteIds } = buildSectionBatch(
    boardNodes,
    plans,
    parsed.nodeLabels,
    parsed.edges,
    styleByMermaidNodeId(mermaidCode),
    parsed.nodeShapes,
  );
  syncLog.debug('subgraph 分区批次已构建', {
    whiteboardId,
    createNodeCount: batch.length,
    deleteNodeCount: deleteIds.length,
  });
  await batchDeleteNodes(client, whiteboardId, deleteIds);
  await createBoardNodes(client, whiteboardId, batch);

  boardNodes = await listBoardNodes(client, whiteboardId);
  await convertGroupNodesToSections(client, whiteboardId, boardNodes);
}
