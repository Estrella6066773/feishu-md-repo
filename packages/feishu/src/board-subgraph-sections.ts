import type { FeishuClient } from './client.js';
import { createLogger, parseMermaidClassStyles, type DiagramNodeStyle } from '@feishu-md/shared';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
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
 * 列与列之间只留折线通道。同级平行项的缝是节点之间的空隙，不是「每项占一整行」。
 * 纵向缝取原先的一半：父节点贴着已经压紧的子节点簇中线，下一棵兄弟子树紧挨着上一棵的底边。
 */
const LANE_GAP_X = 40;
const LANE_GAP_Y = 24;
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
): Promise<void> {
  if (nodes.length === 0) return;

  await withWhiteboardRetry('Create board section nodes', async () => {
    const response = await withRateLimit(() =>
      client.board.v1.whiteboardNode.create({
        path: { whiteboard_id: whiteboardId },
        data: { nodes: nodes as never },
      }),
    );
    assertFeishuResponse(response, 'Create board section nodes');
  });
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
 * 按两块形状的中心决定从哪条边出发、落到哪条边。
 * 左右优先：流程图是从左往右排的，父到子应出右边、进左边；回边则相反。
 * 上下只在目标明显在正上或正下、横向几乎没有错开时使用。
 * 沿边的比例朝向对方中心，避免所有线都钉在边的正中。
 */
function connectorFacingSides(
  start: BlockPlacement,
  end: BlockPlacement,
): { from: SnapSide; to: SnapSide; fromAlong: number; toAlong: number } {
  const startCx = start.x + start.width / 2;
  const startCy = start.y + start.height / 2;
  const endCx = end.x + end.width / 2;
  const endCy = end.y + end.height / 2;
  const dx = endCx - startCx;
  const dy = endCy - startCy;
  const from: SnapSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';
  const to: SnapSide = from === 'right' ? 'left' : from === 'left' ? 'right' : from === 'bottom' ? 'top' : 'bottom';
  return {
    from,
    to,
    fromAlong: alongFacingSide(start, end, from),
    toAlong: alongFacingSide(end, start, to),
  };
}

function alongFacingSide(box: BlockPlacement, other: BlockPlacement, side: SnapSide): number {
  const span = side === 'left' || side === 'right' ? box.height : box.width;
  const origin = side === 'left' || side === 'right' ? box.y : box.x;
  const otherCenter =
    side === 'left' || side === 'right' ? other.y + other.height / 2 : other.x + other.width / 2;
  if (span <= 0) return 0.5;
  return (otherCenter - origin) / span;
}

function clampAttachment(along: number): number {
  if (!Number.isFinite(along)) return 0.5;
  return Math.min(0.85, Math.max(0.15, along));
}

function sidePosition(side: SnapSide, along: number): { x: number; y: number } {
  const t = clampAttachment(along);
  if (side === 'left') return { x: 0, y: t };
  if (side === 'right') return { x: 1, y: t };
  if (side === 'top') return { x: t, y: 0 };
  return { x: t, y: 1 };
}

/**
 * 同一条边上有多根线时，按朝向顺序均匀错开，避免叠在同一个点上。
 * 只有一根线时保留朝向对方中心的位置。
 */
function spreadSharedAttachments(alongByKey: Map<string, number[]>): Map<string, number[]> {
  const spread = new Map<string, number[]>();
  for (const [key, values] of alongByKey) {
    if (values.length <= 1) {
      spread.set(key, values.map((value) => clampAttachment(value)));
      continue;
    }
    const order = values
      .map((value, index) => ({ value, index }))
      .sort((left, right) => left.value - right.value || left.index - right.index);
    const placed = new Array<number>(values.length);
    order.forEach((item, rank) => {
      placed[item.index] = (rank + 1) / (values.length + 1);
    });
    spread.set(key, placed);
  }
  return spread;
}

/**
 * start 与 start_object 都写：创建接口认 start，部分读回仍走已废弃的 start_object。
 * 两边必须是各自的对象，不能共用一份，否则改一端的边会把另一端带歪。
 */
function connectorAttachment(id: string, side: SnapSide, along: number): UnknownRecord {
  return { id, snap_to: side, position: sidePosition(side, along) };
}

/**
 * 折线不写拐点。specified_coordinate 为 false 时，飞书只负责折线怎么拐，不改这里写死的两端。
 * 同分区连线仍挂 parent_id。飞书只在同一次 create 里认自定义父子，不挂的话线会脱离分区。
 * x/y/宽高保持 0，占位给创建接口；包围盒由飞书按两端重算，端点本身不靠这个框。
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
): UnknownRecord {
  const payload: UnknownRecord = {
    id,
    type: 'connector',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    style: defaultConnectorStyle(),
    connector: {
      shape: 'polyline',
      specified_coordinate: false,
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
 * 按节点真实宽高从左往右排，同级节点压成一列。
 * 节约空白的方式和紧凑稿一致：平行项只占自己的高度再加一条窄缝，不按全图最高的块空出一整行；
 * 父节点放在这簇子节点的垂直中线，下一棵兄弟子树从上一棵的底边接着排，中间不再垫空行。
 * 列左对齐，列距只留折线通道。某一列里有一块很宽的节点时，窄节点仍贴着该列左边，避免为了居中再拉开箭头。
 * 多父节点只保留源码里先出现的那条，避免一张网被拉成很多列。
 * 回边不占新的格子：深度已经定过的节点不再递归，否则战役图里的环会把调用栈撑爆。这些边仍然会画成连线。
 */
function computeTreeLayout(
  memberIds: string[],
  memberShapes: BoardNodeRecord[],
  edges: Array<{ from: string; to: string }>,
): TreeLayoutResult {
  const memberSet = new Set(memberIds);
  const children = new Map<string, string[]>();
  const orderIndex = new Map(memberIds.map((id, index) => [id, index]));
  const sizeByMember = new Map<string, { width: number; height: number }>();

  for (const [index, memberId] of memberIds.entries()) {
    children.set(memberId, []);
    const shape = memberShapes[index];
    sizeByMember.set(memberId, {
      width: Math.max(1, Number(shape?.width ?? 140)),
      height: Math.max(1, Number(shape?.height ?? 56)),
    });
  }

  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    if (!memberSet.has(edge.from) || !memberSet.has(edge.to) || edge.from === edge.to) continue;
    if (parentOf.has(edge.to)) continue;
    parentOf.set(edge.to, edge.from);
    const kids = children.get(edge.from)!;
    if (!kids.includes(edge.to)) kids.push(edge.to);
  }

  for (const kids of children.values()) {
    kids.sort((left, right) => (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0));
  }

  const depthByMember = new Map<string, number>();
  const visiting = new Set<string>();

  function assignDepth(nodeId: string, depth: number): void {
    if (depthByMember.has(nodeId) || visiting.has(nodeId)) return;
    visiting.add(nodeId);
    depthByMember.set(nodeId, depth);
    for (const kid of children.get(nodeId) ?? []) {
      assignDepth(kid, depth + 1);
    }
    visiting.delete(nodeId);
  }

  const declaredRoots = memberIds.filter((id) => !parentOf.has(id));
  const depthRoots = declaredRoots.length > 0 ? declaredRoots : memberIds.slice(0, 1);
  for (const root of depthRoots) assignDepth(root, 0);
  for (const memberId of memberIds) {
    if (!depthByMember.has(memberId)) assignDepth(memberId, 0);
  }

  function forwardChildren(nodeId: string): string[] {
    const depth = depthByMember.get(nodeId) ?? 0;
    return (children.get(nodeId) ?? []).filter((kid) => depthByMember.get(kid) === depth + 1);
  }

  const columnWidth = new Map<number, number>();
  for (const [memberId, depth] of depthByMember) {
    const size = sizeByMember.get(memberId)!;
    columnWidth.set(depth, Math.max(columnWidth.get(depth) ?? 0, size.width));
  }
  const columnX = new Map<number, number>();
  const depths = [...columnWidth.keys()].sort((left, right) => left - right);
  let cursorX = 0;
  for (const depth of depths) {
    columnX.set(depth, cursorX);
    cursorX += (columnWidth.get(depth) ?? 0) + LANE_GAP_X;
  }

  const heightMemo = new Map<string, number>();
  function subtreeHeight(nodeId: string): number {
    const cached = heightMemo.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return sizeByMember.get(nodeId)!.height;
    visiting.add(nodeId);
    const kids = forwardChildren(nodeId);
    const own = sizeByMember.get(nodeId)!.height;
    let band = own;
    if (kids.length > 0) {
      const stacked =
        kids.reduce((sum, kid) => sum + subtreeHeight(kid), 0) + LANE_GAP_Y * (kids.length - 1);
      band = Math.max(own, stacked);
    }
    visiting.delete(nodeId);
    heightMemo.set(nodeId, band);
    return band;
  }

  const offsetByMember = new Map<string, { x: number; y: number }>();
  const placed = new Set<string>();

  function place(nodeId: string, top: number): number {
    if (placed.has(nodeId)) return 0;
    // 先量高度并写入缓存。若此时已在 visiting 里，subtreeHeight 会把整棵子树收成自身高度，兄弟会叠住。
    const band = subtreeHeight(nodeId);
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const size = sizeByMember.get(nodeId)!;
    const depth = depthByMember.get(nodeId) ?? 0;
    offsetByMember.set(nodeId, {
      x: columnX.get(depth) ?? 0,
      y: top + (band - size.height) / 2,
    });
    placed.add(nodeId);

    const kids = forwardChildren(nodeId);
    if (kids.length > 0) {
      const stacked =
        kids.reduce((sum, kid) => sum + subtreeHeight(kid), 0) + LANE_GAP_Y * (kids.length - 1);
      let childTop = top + (band - stacked) / 2;
      for (const kid of kids) {
        place(kid, childTop);
        childTop += subtreeHeight(kid) + LANE_GAP_Y;
      }
    }

    visiting.delete(nodeId);
    return band;
  }

  const childOfForward = new Set<string>();
  for (const memberId of memberIds) {
    for (const kid of forwardChildren(memberId)) childOfForward.add(kid);
  }
  const layoutRoots = memberIds.filter((id) => !childOfForward.has(id));
  let cursorY = 0;
  for (const [index, root] of layoutRoots.entries()) {
    if (index > 0) cursorY += LANE_GAP_Y;
    cursorY += place(root, cursorY);
  }

  let contentWidth = 0;
  let contentHeight = 0;
  for (const [memberId, offset] of offsetByMember) {
    const size = sizeByMember.get(memberId)!;
    contentWidth = Math.max(contentWidth, offset.x + size.width);
    contentHeight = Math.max(contentHeight, offset.y + size.height);
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
  }> = [];
  const alongByKey = new Map<string, number[]>();
  const rememberAlong = (key: string, along: number) => {
    const list = alongByKey.get(key) ?? [];
    list.push(along);
    alongByKey.set(key, list);
  };
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

    const facing = connectorFacingSides(startPlacement, endPlacement);
    rememberAlong(`start:${startObjectId}:${facing.from}`, facing.fromAlong);
    rememberAlong(`end:${endObjectId}:${facing.to}`, facing.toAlong);
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
    });
  }

  const spreadAlong = spreadSharedAttachments(alongByKey);
  const taken = new Map<string, number>();
  const takeAlong = (key: string, fallback: number) => {
    const values = spreadAlong.get(key);
    const cursor = taken.get(key) ?? 0;
    taken.set(key, cursor + 1);
    return values?.[cursor] ?? clampAttachment(fallback);
  };
  const connectorPayloads = connectorDrafts.map((draft) =>
    buildGeneratedConnectorPayload(
      draft.id,
      draft.startObjectId,
      draft.endObjectId,
      draft.from,
      takeAlong(`start:${draft.startObjectId}:${draft.from}`, draft.fromAlong),
      draft.to,
      takeAlong(`end:${draft.endObjectId}:${draft.to}`, draft.toAlong),
      draft.sectionId,
      draft.label,
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
 * 带 subgraph 的流程图直接画到空画板上，不经过飞书 Mermaid 导入。
 *
 * 联动：docx-content 与 append-markdown 在导入前调用。返回 true 表示画板已写好，
 * 调用方不要再 importBoardMermaidDiagram，否则会把这块画板清掉。
 * 颜色、菱形、`-->|0|` 标签都写在这一次 create 里，和 applyMermaidSubgraphSections 共用 buildSectionBatch。
 *
 * 注意：没有 subgraph 时返回 false，思维导图和普通小流程图仍走飞书导入。
 * 飞书要求分区、形状、连线在同一次 create 里才能认 parent_id，所以整图一次提交，不要拆批。
 * 节点很多时这次请求会比较大；失败应抛出，由调用方退回 Mermaid 导入。
 */
export async function renderMermaidFlowchartBoard(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
): Promise<boolean> {
  const parsed = parseMermaidGraph(mermaidCode);
  if (parsed.subgraphs.length === 0 || parsed.nodeLabels.size === 0) return false;

  const synthetic = syntheticShapesFromGraph(parsed);
  const plans = planSubgraphSections(synthetic, parsed.subgraphs, parsed.nodeLabels, parsed.edges);
  if (plans.length === 0) return false;

  const { batch } = buildSectionBatch(
    synthetic,
    plans,
    parsed.nodeLabels,
    parsed.edges,
    styleByMermaidNodeId(mermaidCode),
    parsed.nodeShapes,
  );
  if (batch.length === 0) return false;

  const existing = await listBoardNodes(client, whiteboardId);
  const existingIds = existing.map((node) => node.id).filter((id): id is string => Boolean(id));
  await batchDeleteNodes(client, whiteboardId, existingIds);
  await createBoardNodes(client, whiteboardId, batch);
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
 * 和 renderMermaidFlowchartBoard 共用 syntheticShapesFromGraph 与 buildSectionBatch，改布局时两边一起变。
 */
export function previewMermaidFlowchartBoard(mermaidCode: string): {
  ok: boolean;
  sectionCount: number;
  shapeCount: number;
  diamondCount: number;
  connectorCount: number;
  /** 折线且未指定坐标、未写拐点。应与 connectorCount 相同，用来卡住退回直线的改动。 */
  autoPolylineCount: number;
  captionCount: number;
  styledCount: number;
  overlapCount: number;
  overlapSample: string[];
} {
  const empty = {
    ok: false,
    sectionCount: 0,
    shapeCount: 0,
    diamondCount: 0,
    connectorCount: 0,
    autoPolylineCount: 0,
    captionCount: 0,
    styledCount: 0,
    overlapCount: 0,
    overlapSample: [] as string[],
  };
  const parsed = parseMermaidGraph(mermaidCode);
  if (parsed.subgraphs.length === 0 || parsed.nodeLabels.size === 0) return empty;

  const synthetic = syntheticShapesFromGraph(parsed);
  const plans = planSubgraphSections(synthetic, parsed.subgraphs, parsed.nodeLabels, parsed.edges);
  if (plans.length === 0) return empty;

  const { batch } = buildSectionBatch(
    synthetic,
    plans,
    parsed.nodeLabels,
    parsed.edges,
    styleByMermaidNodeId(mermaidCode),
    parsed.nodeShapes,
  );

  let sectionCount = 0;
  let shapeCount = 0;
  let diamondCount = 0;
  let connectorCount = 0;
  let autoPolylineCount = 0;
  let captionCount = 0;
  let styledCount = 0;
  const shapesByParent = new Map<string, Array<{ id: string; x: number; y: number; width: number; height: number }>>();
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
        connector.specified_coordinate === false &&
        !('turning_points' in connector) &&
        explicitSide(startAttached?.snap_to) &&
        explicitSide(endAttached?.snap_to) &&
        typeof startPos?.x === 'number' &&
        typeof startPos?.y === 'number'
      ) {
        autoPolylineCount += 1;
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
    captionCount,
    styledCount,
    overlapCount,
    overlapSample,
  };
}

/**
 * Mermaid 导入后，将 subgraph 重建为 native section：
 * 分区、块、线按整图同一批创建，线端点统一映射到同批 custom id。
 * 连线是折线：不写拐点，折线怎么拐由飞书算；起点和终点的边、沿边位置由本函数按两块形状的相对位置写死。
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
