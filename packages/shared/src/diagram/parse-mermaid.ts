/**
 * 节点外形。圆框是 `((文案))`，菱形框是 `{文案}`，其余括号都按矩形。
 * 画板创建时圆框写成飞书的 ellipse，菱形框写成 flow_chart_diamond。
 */
export type MermaidNodeFrame = 'rect' | 'circle' | 'diamond';

export interface ScannedMermaidNode {
  id: string;
  label: string;
  shape: MermaidNodeFrame;
}

/**
 * 圆框必须排在圆角括号前面。否则 `((文案))` 会先被 `\(([^)]+)\)` 吃成圆角矩形，标签还带一个多余括号。
 * 分组：1 是 id，2 `[[ ]]`，3 `[" "]`，4 `[ ]`，5 `([ ])`，6 `(( ))`，7 `( )`，8 `{ }`。
 */
const NODE_DEF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[([^\]]+)\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\[([^\]]+)\]\)|\(\(([^)]+)\)\)|\(([^)]+)\)|\{([^}]+)\})/g;

function frameFromNodeMatch(match: RegExpMatchArray): MermaidNodeFrame {
  if (match[6] != null) return 'circle';
  if (match[8] != null) return 'diamond';
  return 'rect';
}

/** 从一行里找出节点定义。同一行可以同时有圆框、菱形框和矩形。 */
export function scanMermaidNodeDefs(line: string): ScannedMermaidNode[] {
  const found: ScannedMermaidNode[] = [];
  NODE_DEF_RE.lastIndex = 0;
  for (const match of line.matchAll(NODE_DEF_RE)) {
    const id = match[1];
    if (!id) continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8] ?? id;
    found.push({ id, label: normalizeMermaidNodeLabel(raw), shape: frameFromNodeMatch(match) });
  }
  return found;
}

const NODE_ID_SRC = String.raw`[A-Za-z][A-Za-z0-9_]*`;
/**
 * 箭头后面的 `|标签|` 必须单独吃掉。
 * 若把 `-->` 直接接到下一个节点，`A -->|0| B` 会在 `|` 处匹配失败，条件分支整条丢失。
 * 分组：1 起点，2/3/4 是 `-- 文字 -->` 一类的行内标签，5 是 `|标签|`，6 终点。
 */
const EDGE_SCAN_RE = new RegExp(
  String.raw`\b(${NODE_ID_SRC})\b\s*(?:-->|-\.->|==>|--\s+(.+?)\s+-->|-\.\s+(.+?)\s+->|==\s+(.+?)\s+==>)\s*(?:\|([^|\n]*)\|\s*)?\b(${NODE_ID_SRC})\b`,
  'g',
);

export interface ParsedMermaidNode {
  id: string;
  label: string;
  lineIndex: number;
}

export interface ParsedMermaidEdge {
  from: string;
  to: string;
  /** `-->|0|` 或 `-- 文字 -->` 上的标签。条件图用 1 / 0 表示成立与不成立。 */
  label?: string;
}

export interface ParsedMermaidSource {
  directiveLine: string;
  lines: string[];
  nodes: ParsedMermaidNode[];
  edges: ParsedMermaidEdge[];
}

/** `{"标签"}` 的捕获组会带上引号。引号是形状语法，不能留在文案里，否则对不上画板上的文字。 */
export function normalizeMermaidNodeLabel(raw: string): string {
  const trimmed = raw.replace(/<br\s*\/?>/gi, '\n').trim();
  const quoted = trimmed.match(/^"([\s\S]*)"$/);
  return (quoted?.[1] ?? trimmed).trim();
}

/**
 * 解析一行中的边，支持链式写法：`A --> B --> C` → A→B、B→C。
 * 标准 matchAll 会在匹配后从 `to` 之后继续，导致漏掉后续边。
 */
export function parseEdgesFromLine(line: string): ParsedMermaidEdge[] {
  const edges: ParsedMermaidEdge[] = [];
  let searchFrom = 0;

  while (searchFrom < line.length) {
    EDGE_SCAN_RE.lastIndex = searchFrom;
    const match = EDGE_SCAN_RE.exec(line);
    if (!match || match.index == null) break;

    const from = match[1];
    const to = match[6];
    const label = (match[5] ?? match[2] ?? match[3] ?? match[4])?.trim();
    if (from && to) {
      edges.push(label ? { from, to, label } : { from, to });
    }

    // 从起点 id 末尾继续，下一次会命中终点，从而接上 `A --> B --> C`
    searchFrom = match.index + (from?.length ?? 1);
  }

  return edges;
}

/** 从 Mermaid flowchart / graph 源码解析节点与边 */
export function parseMermaidFlowchart(code: string): ParsedMermaidSource {
  const lines = code.split('\n');
  const nodes: ParsedMermaidNode[] = [];
  const edges: ParsedMermaidEdge[] = [];
  const nodeLineMap = new Map<string, number>();
  let directiveLine = 'flowchart TD';

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) continue;

    if (/^(flowchart|graph)\b/i.test(trimmed)) {
      directiveLine = trimmed;
      continue;
    }

    if (/^classDef\b/i.test(trimmed) || /^class\b/i.test(trimmed)) {
      continue;
    }

    for (const node of scanMermaidNodeDefs(trimmed)) {
      if (!nodeLineMap.has(node.id)) {
        nodeLineMap.set(node.id, lineIndex);
        nodes.push({ id: node.id, label: node.label, lineIndex });
      }
    }

    for (const edge of parseEdgesFromLine(trimmed)) {
      edges.push(edge);
    }
  }

  return { directiveLine, lines, nodes, edges };
}

export function isFlowchartCode(code: string): boolean {
  const firstLine = code.trim().split('\n')[0]?.trim().toLowerCase() ?? '';
  return /^(flowchart|graph)\b/.test(firstLine);
}
