/**
 * 同一起点指出去的线共用一条竖线；不同起点的竖线互相平行，竖直范围叠在一起时错开，避免重合。
 *
 * 联动：board-subgraph-sections 在创建画板节点之前，用两端形状的坐标造样本，
 * 交给 planSharedVerticalBuses。返回的包围盒和拐点写进同一次 create。本文件不请求飞书。
 * 端点仍钉在右边正中和左边正中，这里只决定中间那一段竖线的横坐标。
 *
 * 算法取自两处一手来源，套在「右出左进、只保留一段竖线」这种折线上：
 * - 同一起点的多条线先合成一条干线。libavoid 用 JunctionRef 做这种超边，
 *   ELK 的 libavoid 选项名为 Enable Hyperedges From Common Source。
 *   见 https://www.adaptagrams.org/documentation/router_8h_source.html
 *   与 https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-alg-libavoid.html
 * - 干线在竖直方向上的覆盖区间若重叠，就不能占同一个横坐标。
 *   Hashimoto 与 Stevens 的左边算法把区间分到互不重叠的通道（DAC 1971，
 *   Wire routing by optimizing channel assignment within large apertures）。
 *   通道间距对应 libavoid 的 idealNudgingDistance，避免平行线段贴在一起。
 *
 * 注意：完整的 libavoid 会绕开图形，折线可以有很多段。飞书这条线只能改一个垂直拐点，
 * 所以干线放在起点右缘和最近目标左缘之间。空隙不够时仍把竖线错开，近处的目标会被竖线穿过去。
 * 不想穿块时，先调用 separateBlocksFromRoutes 把块让开，再算竖线。
 * 水平直线没有竖段，不改。样本的 boxX、boxY 必须已经是同一套坐标。
 */

export interface ConnectorElbowSample {
  /** 创建批次中的下标，调用方用它写回对应 payload。 */
  payloadIndex: number;
  /** 起点对象。这个对象指出去的所有线共用一条竖线。 */
  groupKey: string;
  /** 连线包围盒左边缘，与同组其他线同一套坐标。 */
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  turningPoints: Array<{ x: number; y: number }>;
  /**
   * 竖线的绝对横坐标不得小于这个值。
   * 同一层有更长的节点时，竖线排到它的右缘外侧，避免从节点身上穿过去。
   */
  minBusX?: number;
}

/** 写回时连同包围盒一起改。坐标与样本是同一套。 */
export interface SnappedElbow {
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  turningPoints: Array<{ x: number; y: number }>;
}

/** 竖线离开起点右缘的距离。 */
const BUS_GUTTER = 24;
/** 竖线与图形边缘至少留出的空隙。 */
const BUS_MARGIN = 8;
/** 不同起点的竖线在横坐标上至少错开这么多，避免两条线画在一起。 */
const BUS_SEPARATION = 16;
const AXIS_TOLERANCE = 0.5;

/** 已有一段垂直拐弯时返回它在包围盒内的横坐标。 */
function elbowRelativeX(sample: ConnectorElbowSample): number | null {
  const points = sample.turningPoints;
  if (points.length < 2) return null;

  const anchor = points[0]?.x;
  if (anchor == null || !Number.isFinite(anchor)) return null;
  if (points.some((point) => Math.abs(point.x - anchor) > AXIS_TOLERANCE)) return null;

  const ys = points.map((point) => point.y);
  if (Math.max(...ys) - Math.min(...ys) <= AXIS_TOLERANCE) return null;
  return anchor;
}

function elbowYs(sample: ConnectorElbowSample): number[] | null {
  if (sample.boxHeight <= AXIS_TOLERANCE) return null;
  if (elbowRelativeX(sample) != null) {
    return sample.turningPoints.map((point) => point.y);
  }
  if (sample.boxWidth <= AXIS_TOLERANCE) return null;
  return [0, sample.boxHeight];
}

interface VerticalBus {
  y0: number;
  y1: number;
  preferredX: number;
  x: number;
  samples: ConnectorElbowSample[];
}

function rangesOverlap(left: VerticalBus, right: VerticalBus): boolean {
  return left.y0 < right.y1 - AXIS_TOLERANCE && left.y1 > right.y0 + AXIS_TOLERANCE;
}

/**
 * 先给每个起点放一条首选竖线，再按左边算法的顺序处理：
 * 从左到右，若与已经放下的竖线在竖直范围上重叠且距离太近，就往右错开一个间距。
 * 竖直范围不相交的线可以共用横坐标，它们只是平行，并不重合。
 */
function assignBusX(buses: VerticalBus[]): void {
  const ordered = [...buses].sort((left, right) => left.preferredX - right.preferredX || left.y0 - right.y0);
  const placed: VerticalBus[] = [];

  for (const bus of ordered) {
    let x = bus.preferredX;
    let guard = 0;
    while (guard < ordered.length) {
      guard += 1;
      const conflict = placed
        .filter((other) => rangesOverlap(bus, other) && Math.abs(x - other.x) < BUS_SEPARATION - AXIS_TOLERANCE)
        .sort((left, right) => right.x - left.x)[0];
      if (!conflict) break;
      x = conflict.x + BUS_SEPARATION;
    }
    bus.x = x;
    placed.push(bus);
  }
}

function buildBus(samples: ConnectorElbowSample[]): VerticalBus | null {
  const vertical = samples.filter((sample) => elbowYs(sample));
  if (vertical.length === 0) return null;

  const sourceRight = Math.min(...vertical.map((sample) => sample.boxX));
  const nearestTargetLeft = Math.min(...vertical.map((sample) => sample.boxX + Math.max(sample.boxWidth, 0)));
  const minX = sourceRight + BUS_MARGIN;
  const maxX = nearestTargetLeft - BUS_MARGIN;
  const gutterX = sourceRight + BUS_GUTTER;
  const floorX = Math.max(gutterX, ...vertical.map((sample) => sample.minBusX ?? gutterX));
  // 没有更长的节点时，空档不够就停在目标左缘内侧，避免竖线扎进目标。
  // 下限被较长节点抬高之后，不再退回那个节点里面；空档不够时停在下限上，由拉长布局先把目标推开。
  let preferredX: number;
  if (maxX >= floorX) {
    preferredX = Math.min(Math.max(floorX, minX), maxX);
  } else if (floorX > gutterX + AXIS_TOLERANCE) {
    preferredX = floorX;
  } else if (maxX >= minX) {
    preferredX = Math.min(Math.max(gutterX, minX), maxX);
  } else {
    preferredX = gutterX;
  }

  return {
    y0: Math.min(...vertical.map((sample) => sample.boxY)),
    y1: Math.max(...vertical.map((sample) => sample.boxY + sample.boxHeight)),
    preferredX,
    x: preferredX,
    samples: vertical,
  };
}

/**
 * 返回需要改写的子线。已经落在分配好的竖线上、包围盒也不必撑开的，不出现在结果里。
 *
 * blocks 是同一套坐标里的节点。传入后，竖线会避开同一层里更长的节点。
 */
export function planSharedVerticalBuses(
  samples: ConnectorElbowSample[],
  blocks?: Array<{ id: string; x: number; y: number; width: number; height: number }>,
): Map<number, SnappedElbow> {
  if (blocks && blocks.length > 0) applyLongNodeBusFloor(samples, blocks);
  const grouped = new Map<string, ConnectorElbowSample[]>();
  for (const sample of samples) {
    if (!sample.groupKey) continue;
    const group = grouped.get(sample.groupKey) ?? [];
    group.push(sample);
    grouped.set(sample.groupKey, group);
  }

  const buses = [...grouped.values()].flatMap((group) => {
    const bus = buildBus(group);
    return bus ? [bus] : [];
  });
  assignBusX(buses);

  const snaps = new Map<number, SnappedElbow>();
  for (const bus of buses) {
    for (const sample of bus.samples) {
      const ys = elbowYs(sample);
      if (!ys) continue;

      let boxX = sample.boxX;
      let boxWidth = Math.max(sample.boxWidth, 0);
      let relative = bus.x - boxX;
      if (relative < 0) {
        boxWidth += -relative;
        boxX = bus.x;
        relative = 0;
      } else if (relative > boxWidth) {
        boxWidth = relative;
      }

      const current = elbowRelativeX(sample);
      const boxUnchanged =
        Math.abs(boxX - sample.boxX) <= AXIS_TOLERANCE
        && Math.abs(boxWidth - sample.boxWidth) <= AXIS_TOLERANCE;
      if (current != null && Math.abs(current - relative) <= AXIS_TOLERANCE && boxUnchanged) continue;

      snaps.set(sample.payloadIndex, {
        boxX,
        boxY: sample.boxY,
        boxWidth,
        boxHeight: sample.boxHeight,
        turningPoints: ys.map((y) => ({ x: relative, y })),
      });
    }
  }

  return snaps;
}

/**
 * 同一层里更长的节点会向右伸出。竖线若仍贴着短节点的右缘，就会从长节点身上穿过去。
 * 把竖线下限抬到这些节点的右缘外侧。已经在起点右缘以右的节点是后面的层，不拿来抬高下限。
 */
function longNodeBusFloor(
  sourceId: string,
  sourceRight: number,
  y0: number,
  y1: number,
  blocks: Array<{ id: string; x: number; y: number; width: number; height: number }>,
): number {
  let floor = sourceRight + BUS_GUTTER;
  if (y1 - y0 <= AXIS_TOLERANCE) return floor;
  for (const block of blocks) {
    if (block.id === sourceId) continue;
    if (block.x >= sourceRight - AXIS_TOLERANCE) continue;
    const bottom = block.y + block.height;
    if (bottom <= y0 + AXIS_TOLERANCE || block.y >= y1 - AXIS_TOLERANCE) continue;
    const right = block.x + block.width + BUS_MARGIN;
    if (right > floor) floor = right;
  }
  return floor;
}

/**
 * 把起点右侧的节点整列右移，给竖线留出空档。
 *
 * 联动：separateBlocksFromRoutes 每轮先调用这里，再交给 relaxRouteOverlaps。
 * plannedConnectorGeometry 写入拐点时用同一套下限（applyLongNodeBusFloor），
 * 所以这里挪开的距离必须让目标左缘落在下限右侧，否则创建时的竖线仍会扎进目标。
 *
 * 注意：同一层更长的节点留在原列，不往左滑。只移动横坐标不小于起点右缘的节点，
 * 整列加同一个增量，避免后面的层被拆开。纵坐标范围不重叠的节点也会跟着右移，图会变长。
 * 一次只处理一个起点，处理完重算，避免两个起点的增量叠在同一批节点上。
 */
function lengthenLayoutForVerticalBuses(
  blocks: RouteBlock[],
  edges: Array<{ from: string; to: string }>,
): boolean {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const outgoing = new Map<string, RouteBlock[]>();
  for (const edge of edges) {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target || edge.from === edge.to) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(target);
    outgoing.set(edge.from, list);
  }

  for (const [sourceId, targets] of outgoing) {
    const source = byId.get(sourceId);
    if (!source || targets.length === 0) continue;
    const sourceRight = source.x + source.width;
    const centers = [source.y + source.height / 2, ...targets.map((target) => target.y + target.height / 2)];
    const y0 = Math.min(...centers);
    const y1 = Math.max(...centers);
    const floor = longNodeBusFloor(sourceId, sourceRight, y0, y1, blocks);
    // 目标左缘留在竖线右侧，并再留一条竖线的错开距离，后面若还要错开第二条竖线也不会挤回去。
    const minLeft = floor + BUS_MARGIN + BUS_SEPARATION;
    let delta = 0;
    for (const block of blocks) {
      if (block.x + AXIS_TOLERANCE < sourceRight) continue;
      if (block.x < minLeft) delta = Math.max(delta, minLeft - block.x);
    }
    if (delta <= AXIS_TOLERANCE) continue;
    for (const block of blocks) {
      if (block.x + AXIS_TOLERANCE >= sourceRight) block.x += delta;
    }
    return true;
  }
  return false;
}

function applyLongNodeBusFloor(
  samples: ConnectorElbowSample[],
  blocks: Array<{ id: string; x: number; y: number; width: number; height: number }>,
): void {
  const grouped = new Map<string, ConnectorElbowSample[]>();
  for (const sample of samples) {
    if (!sample.groupKey || sample.boxHeight <= AXIS_TOLERANCE) continue;
    const group = grouped.get(sample.groupKey) ?? [];
    group.push(sample);
    grouped.set(sample.groupKey, group);
  }
  for (const [sourceId, group] of grouped) {
    const sourceRight = Math.min(...group.map((sample) => sample.boxX));
    const y0 = Math.min(...group.map((sample) => sample.boxY));
    const y1 = Math.max(...group.map((sample) => sample.boxY + sample.boxHeight));
    const floor = longNodeBusFloor(sourceId, sourceRight, y0, y1, blocks);
    for (const sample of group) sample.minBusX = floor;
  }
}

/** 线和块之间至少留出的空隙。和 BUS_MARGIN 同一档，竖线不会贴着块边。 */
const ROUTE_CLEARANCE = 8;
/** 块和块分开之后保留的间隙。 */
const BLOCK_GAP = 16;
/** 与 board-subgraph-sections 的 LAYOUT_GRID_SIZE 相同。挪完块再对齐，避免差半格又叠上。 */
const ROUTE_GRID = 8;
const SEPARATE_PASSES = 8;

export interface RouteBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 用两端的块造一条「右出左进」的折线样本，交给 planSharedVerticalBuses。
 *
 * 联动：separateBlocksFromRoutes 与 board-subgraph-sections 的 plannedConnectorGeometry 都走这里，
 * 避免「让位时按一套拐点、写入时按另一套」。
 * 高度不超过 AXIS_TOLERANCE 的线没有竖段。
 */
export function elbowSampleBetween(
  payloadIndex: number,
  groupKey: string,
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): ConnectorElbowSample {
  const sourceRight = source.x + source.width;
  const targetLeft = target.x;
  const sourceCenter = source.y + source.height / 2;
  const targetCenter = target.y + target.height / 2;
  const boxHeight = Math.abs(targetCenter - sourceCenter);
  const sourceAbove = sourceCenter <= targetCenter;
  return {
    payloadIndex,
    groupKey,
    boxX: sourceRight,
    boxY: Math.min(sourceCenter, targetCenter),
    boxWidth: targetLeft - sourceRight,
    boxHeight,
    turningPoints:
      boxHeight <= AXIS_TOLERANCE
        ? []
        : [
            { x: 0, y: sourceAbove ? 0 : boxHeight },
            { x: 0, y: sourceAbove ? boxHeight : 0 },
          ],
  };
}

function routeBusX(sample: ConnectorElbowSample, snap: SnappedElbow | undefined): number {
  const placed = snap ?? sample;
  const relative = placed.turningPoints[0]?.x ?? 0;
  return placed.boxX + relative;
}

interface AxisSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function segmentsForEdge(
  source: RouteBlock,
  target: RouteBlock,
  busX: number,
): AxisSegment[] {
  const y0 = source.y + source.height / 2;
  const y1 = target.y + target.height / 2;
  const x0 = source.x + source.width;
  const x1 = target.x;
  if (Math.abs(y0 - y1) <= AXIS_TOLERANCE) {
    return [{ x0, y0, x1, y1: y0 }];
  }
  return [
    { x0, y0, x1: busX, y1: y0 },
    { x0: busX, y0, x1: busX, y1 },
    { x0: busX, y0: y1, x1, y1 },
  ];
}

function spanOverlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  const left = Math.min(a0, a1);
  const right = Math.max(a0, a1);
  return right > b0 + AXIS_TOLERANCE && left < b1 - AXIS_TOLERANCE;
}

/** 轴对齐线段是否进入块。clearance 把块向外扩，用来要求线离开块边。 */
function segmentHitsBlock(segment: AxisSegment, block: RouteBlock, clearance: number): boolean {
  const left = block.x - clearance;
  const right = block.x + block.width + clearance;
  const top = block.y - clearance;
  const bottom = block.y + block.height + clearance;
  const horizontal = Math.abs(segment.y0 - segment.y1) <= AXIS_TOLERANCE;
  if (horizontal) {
    return spanOverlaps(segment.x0, segment.x1, left, right)
      && segment.y0 > top + AXIS_TOLERANCE
      && segment.y0 < bottom - AXIS_TOLERANCE;
  }
  return spanOverlaps(segment.y0, segment.y1, top, bottom)
    && segment.x0 > left + AXIS_TOLERANCE
    && segment.x0 < right - AXIS_TOLERANCE;
}

function mergeDelta(current: number | undefined, next: number): number {
  if (current == null || Math.abs(current) <= AXIS_TOLERANCE) return next;
  if (Math.sign(current) === Math.sign(next)) {
    return Math.sign(next) * Math.max(Math.abs(current), Math.abs(next));
  }
  return Math.abs(next) > Math.abs(current) ? next : current;
}

/** 竖线穿过块时，把块平移到竖线外侧。选移动更短的那一侧。 */
function shiftOffVertical(block: RouteBlock, busX: number): number {
  const pushLeft = busX - ROUTE_CLEARANCE - (block.x + block.width);
  const pushRight = busX + ROUTE_CLEARANCE - block.x;
  return Math.abs(pushLeft) <= Math.abs(pushRight) ? pushLeft : pushRight;
}

/** 横线穿过块时，把块平移到横线外侧。距离相同则往下，避免坐标漂到负方向。 */
function shiftOffHorizontal(block: RouteBlock, lineY: number): number {
  const pushUp = lineY - ROUTE_CLEARANCE - (block.y + block.height);
  const pushDown = lineY + ROUTE_CLEARANCE - block.y;
  return Math.abs(pushUp) < Math.abs(pushDown) ? pushUp : pushDown;
}

function separateTouchingBlocks(blocks: RouteBlock[]): boolean {
  let moved = false;
  for (let pass = 0; pass < blocks.length; pass += 1) {
    let changed = false;
    for (let left = 0; left < blocks.length; left += 1) {
      for (let right = left + 1; right < blocks.length; right += 1) {
        const a = blocks[left]!;
        const b = blocks[right]!;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (overlapX <= AXIS_TOLERANCE || overlapY <= AXIS_TOLERANCE) continue;
        if (overlapX <= overlapY) {
          const later = a.x + a.width / 2 <= b.x + b.width / 2 ? b : a;
          later.x = snapRouteCoord(later.x + overlapX + BLOCK_GAP, 1);
        } else {
          const lower = a.y + a.height / 2 <= b.y + b.height / 2 ? b : a;
          lower.y = snapRouteCoord(lower.y + overlapY + BLOCK_GAP, 1);
        }
        changed = true;
        moved = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}

/** 沿挪动方向对齐到网格。往右、往下用向上取整，往左、往上用向下取整，避免对齐后又退回块里面。 */
function snapRouteCoord(value: number, direction: number): number {
  if (direction < 0) return Math.floor(value / ROUTE_GRID + 1e-9) * ROUTE_GRID;
  return Math.ceil(value / ROUTE_GRID - 1e-9) * ROUTE_GRID;
}

/**
 * 统计还有多少条线段进入了块。端点只算真正穿进内部，旁边的块要离开 ROUTE_CLEARANCE。
 * 检查脚本用来确认 separateBlocksFromRoutes 已经让开。
 */
export function routeBlockHitCount(
  blocks: RouteBlock[],
  edges: Array<{ from: string; to: string }>,
): number {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const live = edges.filter((edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to));
  const samples = live.map((edge, index) =>
    elbowSampleBetween(index, edge.from, byId.get(edge.from)!, byId.get(edge.to)!),
  );
  const snaps = planSharedVerticalBuses(samples, blocks);
  let hits = 0;
  live.forEach((edge, index) => {
    const source = byId.get(edge.from)!;
    const target = byId.get(edge.to)!;
    const sample = samples[index]!;
    const busX = routeBusX(sample, snaps.get(sample.payloadIndex));
    for (const segment of segmentsForEdge(source, target, busX)) {
      const horizontal = Math.abs(segment.y0 - segment.y1) <= AXIS_TOLERANCE;
      for (const block of blocks) {
        if (block.id === source.id) continue;
        if (block.id === target.id) {
          if (horizontal || !segmentHitsBlock(segment, block, 0)) continue;
          hits += 1;
          continue;
        }
        if (segmentHitsBlock(segment, block, ROUTE_CLEARANCE)) hits += 1;
      }
    }
  });
  return hits;
}

function relaxRouteOverlaps(
  blocks: RouteBlock[],
  edges: Array<{ from: string; to: string }>,
): boolean {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const live = edges.filter((edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to));
  const samples = live.map((edge, index) =>
    elbowSampleBetween(index, edge.from, byId.get(edge.from)!, byId.get(edge.to)!),
  );
  const snaps = planSharedVerticalBuses(samples, blocks);
  const shiftX = new Map<string, number>();
  const shiftY = new Map<string, number>();

  live.forEach((edge, index) => {
    const source = byId.get(edge.from)!;
    const target = byId.get(edge.to)!;
    const sample = samples[index]!;
    const busX = routeBusX(sample, snaps.get(sample.payloadIndex));
    for (const segment of segmentsForEdge(source, target, busX)) {
      const horizontal = Math.abs(segment.y0 - segment.y1) <= AXIS_TOLERANCE;
      for (const block of blocks) {
        if (block.id === source.id) continue;
        const endpoint = block.id === target.id;
        if (endpoint) {
          // 目标从左边进入。横段贴着左缘不算穿过；竖线扎进目标时只沿水平方向把目标推开。
          if (horizontal) continue;
          if (!segmentHitsBlock(segment, block, 0)) continue;
          shiftX.set(block.id, mergeDelta(shiftX.get(block.id), shiftOffVertical(block, segment.x0)));
          continue;
        }
        if (!segmentHitsBlock(segment, block, ROUTE_CLEARANCE)) continue;
        if (horizontal) {
          shiftY.set(block.id, mergeDelta(shiftY.get(block.id), shiftOffHorizontal(block, segment.y0)));
        } else {
          shiftX.set(block.id, mergeDelta(shiftX.get(block.id), shiftOffVertical(block, segment.x0)));
        }
      }
    }
  });

  let moved = false;
  for (const block of blocks) {
    const dx = shiftX.get(block.id) ?? 0;
    const dy = shiftY.get(block.id) ?? 0;
    if (Math.abs(dx) > AXIS_TOLERANCE) {
      block.x = snapRouteCoord(block.x + dx, dx);
      moved = true;
    }
    if (Math.abs(dy) > AXIS_TOLERANCE) {
      block.y = snapRouteCoord(block.y + dy, dy);
      moved = true;
    }
  }
  if (separateTouchingBlocks(blocks)) moved = true;
  return moved;
}

/**
 * 在现有共用竖线之上，把挡住线的块挪开，直到线不再穿过块，块与块也不再叠住。
 *
 * 联动：board-subgraph-sections 在 Dagre 排完、写入创建 payload 之前调用。
 * 调用方随后仍用 planSharedVerticalBuses 写拐点，所以这里不改线的拐点格式，只改块的 x/y。
 * 竖线位置会跟着块的右缘重新算，等同于线和块一起让开。
 *
 * 注意：原地修改 blocks。飞书仍是一次 create，这里不能去改已经画上的节点。
 * 每一轮先把图拉长，让竖线排到同层较长节点的右缘外侧；再按这条竖线把挡住线的块挪开。
 * 端点只在线穿进内部时才挪；横线贴着目标左缘不算穿过。
 * 拉长和让位交替进行，直到两者都不再移动。轮数是节点数加上 SEPARATE_PASSES，避免只拉长了前几个起点。
 */
export function separateBlocksFromRoutes(
  blocks: RouteBlock[],
  edges: Array<{ from: string; to: string }>,
): void {
  // 拉长和让位会互相改横坐标。轮数按节点数加上限，避免一个起点占满 SEPARATE_PASSES 后其余起点没排开。
  const limit = blocks.length + SEPARATE_PASSES;
  for (let pass = 0; pass < limit; pass += 1) {
    const lengthened = lengthenLayoutForVerticalBuses(blocks, edges);
    const relaxed = relaxRouteOverlaps(blocks, edges);
    if (!lengthened && !relaxed) return;
  }
}
