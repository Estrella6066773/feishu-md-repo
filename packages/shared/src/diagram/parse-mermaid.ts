const NODE_DEF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[([^\]]+)\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\[([^\]]+)\]\)|\(([^)]+)\)|\{([^}]+)\})/g;

const EDGE_ARROW_RE = /(?:--(?:[^>-]+)?-->|-->|-\.(?:[^>-]+)?->|==(?:[^>=]+)?==>)/;
const EDGE_SCAN_RE = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9_]*)\b\s*${EDGE_ARROW_RE.source}\s*\b([A-Za-z][A-Za-z0-9_]*)\b`,
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
    const to = match[2];
    if (from && to) {
      edges.push({ from, to });
    }

    // 从 `to` 节点起点继续，使其可作为下一条边的 from
    searchFrom = match.index + (match[1]?.length ?? 1);
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
