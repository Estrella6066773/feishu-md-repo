const NODE_DEF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[([^\]]+)\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\[([^\]]+)\]\)|\(([^)]+)\)|\{([^}]+)\})/g;

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

function unescapeLabel(raw: string): string {
  return raw.replace(/<br\s*\/?>/gi, '\n').trim();
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

    for (const match of trimmed.matchAll(NODE_DEF_RE)) {
      const nodeId = match[1];
      if (!nodeId) continue;
      const label = unescapeLabel(
        match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? nodeId,
      );
      if (!nodeLineMap.has(nodeId)) {
        nodeLineMap.set(nodeId, lineIndex);
        nodes.push({ id: nodeId, label, lineIndex });
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
