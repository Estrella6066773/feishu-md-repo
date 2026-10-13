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
 * 所以干线放在起点右缘和最近目标左缘之间；空隙不够时仍保证错开，近处的目标允许竖线越过去再折回。
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
  const preferredX = maxX >= minX
    ? Math.min(Math.max(sourceRight + BUS_GUTTER, minX), maxX)
    : sourceRight + BUS_GUTTER;

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
 */
export function planSharedVerticalBuses(
  samples: ConnectorElbowSample[],
): Map<number, SnappedElbow> {
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
