import type { FeishuClient } from './client.js';
import { createLogger } from '@feishu-md/shared';
import { assertFeishuResponse, withRateLimit } from './api-error.js';
import { listWhiteboardNodes } from './export/board-export.js';
import { parseFeishuDocumentUrl } from './export/document-url.js';
import { findBoardWhiteboardId } from './board-service.js';

const terrainLog = createLogger('board-terrain');

type UnknownRecord = Record<string, unknown>;

/** 从飞书画板直链中提取 whiteboard_id（形如 /board/<token>） */
export function parseFeishuBoardUrl(url: string): string | null {
  const match = /\/board\/([A-Za-z0-9_-]+)/.exec(url.trim());
  return match?.[1] ?? null;
}

/**
 * 解析地形来源链接为 whiteboard_id：
 * - 画板直链（…/board/<token>）直接取；
 * - 云文档链接（…/docx/… 或 …/wiki/…）从正文定位画板块取第一个 whiteboard_id；
 * - 其余链接视为无法识别。
 */
export async function resolveBoardTerrainWhiteboardId(
  client: FeishuClient,
  url: string,
): Promise<string> {
  const trimmed = url.trim();

  const boardId = parseFeishuBoardUrl(trimmed);
  if (boardId) return boardId;

  const document = parseFeishuDocumentUrl(trimmed);
  if (document) {
    const whiteboardId = await findBoardWhiteboardId(client, document.token);
    if (whiteboardId) return whiteboardId;
    throw new Error('文档中未找到画板块，请确认该文档内已插入画板');
  }

  throw new Error('无法识别链接：请粘贴画板直链（…/board/…）或含画板的云文档链接');
}

export type BoardTerrainShapeKind = 'ellipse' | 'rect';

export interface BoardTerrainShape {
  /** 画板节点 ID */
  id: string;
  /** 形状类型：ellipse 或 rect（round_rect 归为 rect） */
  kind: BoardTerrainShapeKind;
  /** 颜色值（保留 #，小写） */
  color: string;
  /** 画板坐标 x（px）；所有形状均为旋转前包围盒左上角 */
  x: number;
  /** 画板坐标 y（px，向下为正）；所有形状均为旋转前包围盒左上角 */
  y: number;
  width: number;
  height: number;
  angle: number;
}

export interface ExtractBoardTerrainResult {
  /** 识别出的几何体 */
  shapes: BoardTerrainShape[];
  /** 画板节点总数 */
  totalNodeCount: number;
  /** 形状命中数（未按颜色过滤前） */
  matchedShapeCount: number;
}

/** 归一化颜色：去掉 #、转小写；匹配时双方都归一化 */
function normalizeColor(value: unknown): string {
  return String(value ?? '').replace(/^#/, '').toLowerCase();
}

function isEllipseShape(node: UnknownRecord): boolean {
  const shapeType = String((node.composite_shape as UnknownRecord | undefined)?.type ?? '');
  return shapeType === 'ellipse';
}

function isRectLikeShape(node: UnknownRecord): boolean {
  const shapeType = String((node.composite_shape as UnknownRecord | undefined)?.type ?? '');
  return shapeType === 'rect' || shapeType === 'round_rect';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 读取画板节点，识别指定颜色的圆形与矩形几何体。
 * - 形状：ellipse → 圆形；rect / round_rect → 矩形；其余形状忽略；
 * - 颜色：仅保留 style.fill_color 命中指定颜色列表的节点（大小写不敏感）。
 */
export async function extractBoardTerrainShapes(
  client: FeishuClient,
  whiteboardId: string,
  colors: string[],
): Promise<ExtractBoardTerrainResult> {
  const normalizedTargets = new Set(colors.map(normalizeColor).filter(Boolean));
  const nodes = await listWhiteboardNodes(client, whiteboardId);

  const shapes: BoardTerrainShape[] = [];
  let matchedShapeCount = 0;

  for (const node of nodes) {
    if (String(node.type ?? '') !== 'composite_shape') continue;
    if (!isEllipseShape(node) && !isRectLikeShape(node)) continue;

    matchedShapeCount += 1;

    const rawColor = (node.style as UnknownRecord | undefined)?.fill_color;
    const color = normalizeColor(rawColor);
    if (!normalizedTargets.has(color)) continue;

    const id = String(node.id ?? '');
    if (!id) continue;

    shapes.push({
      id,
      kind: isEllipseShape(node) ? 'ellipse' : 'rect',
      color: `#${color}`,
      x: numberValue(node.x),
      y: numberValue(node.y),
      width: numberValue(node.width),
      height: numberValue(node.height),
      angle: numberValue(node.angle),
    });
  }

  terrainLog.info('画板地形识别完成', {
    whiteboardId,
    totalNodeCount: nodes.length,
    matchedShapeCount,
    matchedColorCount: shapes.length,
  });

  return { shapes, totalNodeCount: nodes.length, matchedShapeCount };
}
