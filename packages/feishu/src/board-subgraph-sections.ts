import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
import { parseMermaidGraph, type ParsedMermaidSubgraph } from './mermaid-subgraph.js';

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
const BLOCK_GAP_X = 240;
const BLOCK_GAP_Y = 120;
const WHITEBOARD_RETRY_DELAYS_MS = [800, 1200, 2000, 3000, 4000];

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
      await sleep(WHITEBOARD_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${action} failed after retries`);
}

async function listBoardNodes(client: FeishuClient, whiteboardId: string): Promise<BoardNodeRecord[]> {
  return withWhiteboardRetry('List board nodes for subgraph sections', async () => {
    const response = await withRateLimit(() =>
      client.board.v1.whiteboardNode.list({
        path: { whiteboard_id: whiteboardId },
      }),
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
    subgraphTitles.has(nodeText(node)) &&
    fillColor(node) === '#ffffde'
  );
}

function shapeTextPayload(shape: BoardNodeRecord): UnknownRecord {
  const label = nodeText(shape);
  return { text: label.slice(0, 1024) || ' ' };
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

function toRelativeCoordinate(global: number | undefined, sectionOrigin: number): number {
  return Number(global ?? 0) - sectionOrigin;
}

function buildSectionPayload(
  id: string,
  title: string,
  bounds: { x: number; y: number; width: number; height: number },
  zIndex: number,
): UnknownRecord {
  return {
    id,
    type: 'section',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    z_index: zIndex,
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
}

// 这里的“块”对应飞书画板的 composite_shape，是实际承载文本的最小单位。
function buildBlockPayload(
  id: string,
  sectionId: string,
  block: BoardNodeRecord,
  zIndex: number,
  sectionOrigin: { x: number; y: number },
): UnknownRecord {
  return {
    id,
    type: 'composite_shape',
    parent_id: sectionId,
    x: toRelativeCoordinate(block.x, sectionOrigin.x),
    y: toRelativeCoordinate(block.y, sectionOrigin.y),
    width: block.width,
    height: block.height,
    angle: block.angle ?? 0,
    text: shapeTextPayload(block),
    composite_shape: {
      type:
        typeof (block.composite_shape as UnknownRecord | undefined)?.type === 'string'
          ? String((block.composite_shape as UnknownRecord).type)
          : 'round_rect',
    },
    z_index: zIndex,
  };
}

function buildTopLevelBlockPayload(id: string, block: BoardNodeRecord): UnknownRecord {
  return {
    id,
    type: 'composite_shape',
    x: block.x,
    y: block.y,
    width: block.width,
    height: block.height,
    angle: block.angle ?? 0,
    text: shapeTextPayload(block),
    composite_shape: {
      type:
        typeof (block.composite_shape as UnknownRecord | undefined)?.type === 'string'
          ? String((block.composite_shape as UnknownRecord).type)
          : 'round_rect',
    },
    z_index: Number(block.z_index ?? 1),
  };
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

function getConnectorEndpointIds(conn: BoardNodeRecord): { startId: string; endId: string } {
  const connector = conn.connector ?? {};
  const startId = String(
    (connector.start_object as UnknownRecord | undefined)?.id ??
      ((connector.start as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined)?.id ??
      '',
  );
  const endId = String(
    (connector.end_object as UnknownRecord | undefined)?.id ??
      ((connector.end as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined)?.id ??
      '',
  );
  return { startId, endId };
}

function remapEndpoint(
  endpoint: UnknownRecord | undefined,
  idMap: Map<string, string>,
): UnknownRecord | undefined {
  if (!endpoint) return undefined;
  const oldId = String(endpoint.id ?? '');
  return {
    id: idMap.get(oldId) ?? oldId,
    snap_to: endpoint.snap_to,
    position: endpoint.position,
  };
}

function connectorEndpoint(
  id: string | undefined,
  snapTo: 'left' | 'right' | 'top' | 'bottom',
): UnknownRecord | undefined {
  if (!id) return undefined;
  const position =
    snapTo === 'left'
      ? { x: 0, y: 0.5 }
      : snapTo === 'right'
        ? { x: 1, y: 0.5 }
        : snapTo === 'top'
          ? { x: 0.5, y: 0 }
          : { x: 0.5, y: 1 };
  return { id, snap_to: snapTo, position };
}

function chooseConnectorSnap(
  from: BlockPlacement | undefined,
  to: BlockPlacement | undefined,
  isStart: boolean,
): 'left' | 'right' | 'top' | 'bottom' {
  if (!from || !to) return isStart ? 'right' : 'left';

  if (from.rank != null && to.rank != null && from.rank !== to.rank) {
    const forward = to.rank > from.rank;
    if (isStart) return forward ? 'right' : 'left';
    return forward ? 'left' : 'right';
  }

  const fromCenterX = from.x + from.width / 2;
  const fromCenterY = from.y + from.height / 2;
  const toCenterX = to.x + to.width / 2;
  const toCenterY = to.y + to.height / 2;
  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;

  if (Math.abs(dx) > Math.abs(dy)) {
    if (isStart) return dx >= 0 ? 'right' : 'left';
    return dx >= 0 ? 'left' : 'right';
  }

  if (isStart) return dy >= 0 ? 'bottom' : 'top';
  return dy >= 0 ? 'top' : 'bottom';
}

function connectorAnchorPosition(placement: BlockPlacement | undefined): { x: number; y: number } {
  if (!placement) return { x: 0, y: 0 };
  return {
    x: placement.x + placement.width / 2,
    y: placement.y + placement.height / 2,
  };
}

function connectorLayoutPosition(
  conn: BoardNodeRecord,
  placements: Map<string, BlockPlacement> | undefined,
  startPlacement: BlockPlacement | undefined,
  endPlacement: BlockPlacement | undefined,
): { x: number; y: number; width: number; height: number } {
  if (!placements || !startPlacement || !endPlacement) {
    return {
      x: conn.x ?? 0,
      y: conn.y ?? 0,
      width: conn.width ?? 0,
      height: conn.height ?? 0,
    };
  }

  const startAnchor = connectorAnchorPosition(startPlacement);
  const endAnchor = connectorAnchorPosition(endPlacement);
  return {
    x: Math.min(startAnchor.x, endAnchor.x),
    y: Math.min(startAnchor.y, endAnchor.y),
    width: Math.abs(endAnchor.x - startAnchor.x),
    height: Math.abs(endAnchor.y - startAnchor.y),
  };
}

function buildConnectorPayload(
  conn: BoardNodeRecord,
  id: string,
  idMap: Map<string, string>,
  sectionId?: string,
  sectionOrigin?: { x: number; y: number },
  placements?: Map<string, BlockPlacement>,
): UnknownRecord {
  const connector = conn.connector ?? {};
  const { startId, endId } = getConnectorEndpointIds(conn);
  const startBlock = (connector.start as UnknownRecord | undefined) ?? {
    arrow_style: 'none',
    attached_object: connector.start_object,
  };
  const endBlock = (connector.end as UnknownRecord | undefined) ?? {
    arrow_style: 'triangle_arrow',
    attached_object: connector.end_object,
  };
  const startAttached = remapEndpoint(
    (startBlock.attached_object as UnknownRecord | undefined) ??
      (connector.start_object as UnknownRecord | undefined),
    idMap,
  );
  const endAttached = remapEndpoint(
    (endBlock.attached_object as UnknownRecord | undefined) ??
      (connector.end_object as UnknownRecord | undefined),
    idMap,
  );
  const startPlacement = placements?.get(startId);
  const endPlacement = placements?.get(endId);
  const readableStartAttached =
    placements && startPlacement && endPlacement
      ? connectorEndpoint(
          idMap.get(startId) ?? startId,
          chooseConnectorSnap(startPlacement, endPlacement, true),
        )
      : startAttached;
  const readableEndAttached =
    placements && startPlacement && endPlacement
      ? connectorEndpoint(
          idMap.get(endId) ?? endId,
          chooseConnectorSnap(startPlacement, endPlacement, false),
        )
      : endAttached;
  const position = connectorLayoutPosition(conn, placements, startPlacement, endPlacement);

  const payload: UnknownRecord = {
    id,
    type: 'connector',
    x: position.x,
    y: position.y,
    width: position.width,
    height: position.height,
    angle: conn.angle ?? 0,
    style: conn.style ?? defaultConnectorStyle(),
    connector: {
      shape: 'straight',
      specified_coordinate: connector.specified_coordinate ?? true,
      caption_auto_direction: connector.caption_auto_direction ?? false,
      turning_points: [],
      start: {
        arrow_style: startBlock.arrow_style ?? 'none',
        attached_object: readableStartAttached,
      },
      end: {
        arrow_style: endBlock.arrow_style ?? 'triangle_arrow',
        attached_object: readableEndAttached,
      },
      start_object: readableStartAttached,
      end_object: readableEndAttached,
    },
    z_index: Number(conn.z_index ?? 1),
  };

  if (sectionId && sectionOrigin) {
    payload.parent_id = sectionId;
    payload.x = toRelativeCoordinate(position.x, sectionOrigin.x);
    payload.y = toRelativeCoordinate(position.y, sectionOrigin.y);
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
      nodeText(node) === subgraph.title &&
      !memberLabels.has(nodeText(node)),
  );
}

interface SectionBuildPlan {
  subgraph: ParsedMermaidSubgraph;
  sectionId: string;
  bounds: { x: number; y: number; width: number; height: number };
  memberIds: string[];
  memberShapes: BoardNodeRecord[];
  titleShape?: BoardNodeRecord;
  minZIndex: number;
  ranks: Map<string, number>;
}

interface BlockPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  rank?: number;
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

      const matches = boardNodes.filter(
        (node) =>
          node.type === 'composite_shape' &&
          node.id &&
          !node.parent_id &&
          !consumedShapeIds.has(node.id) &&
          nodeText(node) === label.trim(),
      );
      if (matches.length === 1) {
        memberPairs.push({ memberId, shape: matches[0]! });
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
    const minZIndex = [...memberShapes, ...(titleShape ? [titleShape] : [])].reduce(
      (min, node) => Math.min(min, Number(node.z_index ?? 0)),
      0,
    );

    plans.push({
      subgraph,
      sectionId: `sg${index + 1}:1`,
      bounds,
      memberIds,
      memberShapes,
      titleShape,
      minZIndex,
      ranks: computeNodeRanks(memberIds, edges),
    });

    for (const shape of memberShapes) {
      if (shape.id) consumedShapeIds.add(shape.id);
    }
  }

  return plans;
}

function computeNodeRanks(
  memberIds: string[],
  edges: Array<{ from: string; to: string }>,
): Map<string, number> {
  const memberSet = new Set(memberIds);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const ranks = new Map<string, number>();

  for (const memberId of memberIds) {
    incoming.set(memberId, 0);
    outgoing.set(memberId, []);
    ranks.set(memberId, 0);
  }

  for (const edge of edges) {
    if (!memberSet.has(edge.from) || !memberSet.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const queue = memberIds.filter((memberId) => (incoming.get(memberId) ?? 0) === 0);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    visited.add(current);
    const nextRank = (ranks.get(current) ?? 0) + 1;
    for (const next of outgoing.get(current) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, nextRank));
      incoming.set(next, (incoming.get(next) ?? 0) - 1);
      if ((incoming.get(next) ?? 0) === 0) {
        queue.push(next);
      }
    }
  }

  // 环形关系无法完全拓扑排序时，保留已知 rank，其余节点放在最后一列。
  const fallbackRank = Math.max(0, ...ranks.values()) + 1;
  for (const memberId of memberIds) {
    if (!visited.has(memberId) && (outgoing.get(memberId)?.length ?? 0) > 0) {
      ranks.set(memberId, fallbackRank);
    }
  }

  return ranks;
}

function applyReadableLayout(
  plans: SectionBuildPlan[],
): Map<string, BlockPlacement> {
  const placementByShapeId = new Map<string, BlockPlacement>();
  const allShapes = plans.flatMap((plan) => plan.memberShapes);
  const baseX = snapFloor(Math.min(...allShapes.map((shape) => Number(shape.x ?? 0))));
  const baseY = snapFloor(Math.min(...allShapes.map((shape) => Number(shape.y ?? 0))));
  let cursorX = baseX;

  for (const plan of plans) {
    const columns = new Map<number, BoardNodeRecord[]>();
    plan.memberShapes.forEach((shape, index) => {
      const memberId = plan.memberIds[index]!;
      const rank = plan.ranks.get(memberId) ?? 0;
      const column = columns.get(rank) ?? [];
      column.push(shape);
      columns.set(rank, column);
    });

    const sortedRanks = [...columns.keys()].sort((left, right) => left - right);
    const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
    const maxBlockWidth = Math.max(
      120,
      ...plan.memberShapes.map((shape) => Number(shape.width ?? 120)),
    );
    const maxBlockHeight = Math.max(
      56,
      ...plan.memberShapes.map((shape) => Number(shape.height ?? 56)),
    );

    const contentWidth =
      sortedRanks.length <= 1
        ? maxBlockWidth
        : (sortedRanks.length - 1) * BLOCK_GAP_X + maxBlockWidth;
    const contentHeight =
      maxRows <= 1 ? maxBlockHeight : (maxRows - 1) * BLOCK_GAP_Y + maxBlockHeight;
    const width = Math.max(SECTION_MIN_WIDTH, SECTION_PADDING * 2 + contentWidth);
    const height = Math.max(
      SECTION_MIN_HEIGHT,
      SECTION_TITLE_HEIGHT + SECTION_PADDING * 2 + contentHeight,
    );

    plan.bounds = {
      x: cursorX,
      y: baseY,
      width: snapCeil(width),
      height: snapCeil(height),
    };

    for (const rank of sortedRanks) {
      const column = columns.get(rank) ?? [];
      const columnHeight =
        column.length <= 1
          ? maxBlockHeight
          : (column.length - 1) * BLOCK_GAP_Y + maxBlockHeight;
      const startY =
        plan.bounds.y +
        SECTION_TITLE_HEIGHT +
        SECTION_PADDING +
        Math.max(0, (contentHeight - columnHeight) / 2);

      column.forEach((shape, rowIndex) => {
        if (!shape.id) return;
        const x = plan.bounds.x + SECTION_PADDING + rank * BLOCK_GAP_X;
        const y = startY + rowIndex * BLOCK_GAP_Y;
        shape.x = snapCeil(x);
        shape.y = snapCeil(y);
        placementByShapeId.set(String(shape.id), {
          x: Number(shape.x),
          y: Number(shape.y),
          width: Number(shape.width ?? maxBlockWidth),
          height: Number(shape.height ?? maxBlockHeight),
          rank,
        });
      });
    }

    cursorX += plan.bounds.width + SECTION_GAP_X;
  }

  return placementByShapeId;
}

function findSectionForShape(
  shapeId: string,
  shapeSectionMap: Map<string, SectionBuildPlan>,
): SectionBuildPlan | undefined {
  return shapeSectionMap.get(shapeId);
}

function buildSectionBatch(
  boardNodes: BoardNodeRecord[],
  plans: SectionBuildPlan[],
): { batch: UnknownRecord[]; deleteIds: string[] } {
  const placementByShapeId = applyReadableLayout(plans);
  const shapeIdMap = new Map<string, string>();
  const shapeSectionMap = new Map<string, SectionBuildPlan>();
  const blockPayloads: UnknownRecord[] = [];
  const externalBlockPayloads: UnknownRecord[] = [];
  const deleteIds: string[] = [];
  const titleShapeIds = new Set<string>();
  const subgraphTitles = new Set(plans.map((plan) => plan.subgraph.title));
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
      const newId = `${plan.sectionId.replace(':1', '')}:${index + 2}`;
      shapeIdMap.set(oldId, newId);
      shapeSectionMap.set(oldId, plan);
      deleteIds.push(oldId);
      blockPayloads.push(buildBlockPayload(newId, plan.sectionId, shape, index + 1, plan.bounds));
    });
  }

  const mapExternalBlock = (shapeId: string): boolean => {
    if (shapeIdMap.has(shapeId)) return true;
    if (titleShapeIds.has(shapeId)) return false;

    const block = boardNodes.find(
      (node) => node.id === shapeId && node.type === 'composite_shape' && !node.parent_id,
    );
    if (!block?.id) return false;

    const newId = `sgo:${externalBlockPayloads.length + 1}`;
    block.x = snapCeil(Number(block.x ?? 0));
    block.y = snapCeil(Number(block.y ?? 0));
    shapeIdMap.set(shapeId, newId);
    placementByShapeId.set(shapeId, {
      x: Number(block.x ?? 0),
      y: Number(block.y ?? 0),
      width: Number(block.width ?? 120),
      height: Number(block.height ?? 56),
    });
    deleteIds.push(shapeId);
    externalBlockPayloads.push(buildTopLevelBlockPayload(newId, block));
    return true;
  };

  let mappedMore = true;
  while (mappedMore) {
    mappedMore = false;
    for (const conn of boardNodes) {
      if (conn.type !== 'connector' || !conn.id || conn.parent_id) continue;
      const { startId, endId } = getConnectorEndpointIds(conn);
      const startMapped = shapeIdMap.has(startId);
      const endMapped = shapeIdMap.has(endId);
      if (!startMapped && !endMapped) continue;

      if (!startMapped && mapExternalBlock(startId)) mappedMore = true;
      if (!endMapped && mapExternalBlock(endId)) mappedMore = true;
    }
  }

  const connectorPayloads: UnknownRecord[] = [];
  for (const conn of boardNodes) {
    if (conn.type !== 'connector' || !conn.id || conn.parent_id) continue;
    const { startId, endId } = getConnectorEndpointIds(conn);
    const startMapped = shapeIdMap.has(startId);
    const endMapped = shapeIdMap.has(endId);
    if (!startMapped && !endMapped) continue;

    deleteIds.push(String(conn.id));
    if (!startMapped || !endMapped) continue;

    const startSection = findSectionForShape(startId, shapeSectionMap);
    const endSection = findSectionForShape(endId, shapeSectionMap);
    const sameSection = startSection && endSection && startSection.sectionId === endSection.sectionId;
    const connectorId = sameSection
      ? `${startSection.sectionId.replace(':1', '')}:c${(sectionConnectorCounts.get(startSection.sectionId) ?? 0) + 1}`
      : `sgc:${connectorPayloads.length + 1}`;
    if (sameSection) {
      sectionConnectorCounts.set(
        startSection.sectionId,
        (sectionConnectorCounts.get(startSection.sectionId) ?? 0) + 1,
      );
    }

    connectorPayloads.push(
      buildConnectorPayload(
        conn,
        connectorId,
        shapeIdMap,
        sameSection ? startSection.sectionId : undefined,
        sameSection ? startSection.bounds : undefined,
        placementByShapeId,
      ),
    );
  }

  const sectionPayloads = plans.map((plan) => {
    return buildSectionPayload(
      plan.sectionId,
      plan.subgraph.title,
      plan.bounds,
      Math.max(0, plan.minZIndex - 1),
    );
  });

  return {
    batch: [...sectionPayloads, ...blockPayloads, ...externalBlockPayloads, ...connectorPayloads],
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

/**
 * Mermaid 导入后，将 subgraph 重建为 native section：
 * 分区、块、线按整图同一批创建，线端点统一映射到同批 custom id。
 * 分区内线挂 parent_id 到分区，跨分区线保持全局线。
 */
export async function applyMermaidSubgraphSections(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
): Promise<void> {
  const parsed = parseMermaidGraph(mermaidCode);
  if (parsed.subgraphs.length === 0) {
    const boardNodes = await listBoardNodes(client, whiteboardId);
    await convertGroupNodesToSections(client, whiteboardId, boardNodes);
    return;
  }

  let boardNodes = await listBoardNodes(client, whiteboardId);
  const plans = planSubgraphSections(boardNodes, parsed.subgraphs, parsed.nodeLabels, parsed.edges);
  if (plans.length === 0) {
    await convertGroupNodesToSections(client, whiteboardId, boardNodes);
    return;
  }

  const { batch, deleteIds } = buildSectionBatch(boardNodes, plans);
  await batchDeleteNodes(client, whiteboardId, deleteIds);
  await createBoardNodes(client, whiteboardId, batch);

  boardNodes = await listBoardNodes(client, whiteboardId);
  await convertGroupNodesToSections(client, whiteboardId, boardNodes);
}
