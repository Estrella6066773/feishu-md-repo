export interface ParsedMermaidSubgraph {
  id: string;
  title: string;
  memberIds: string[];
  depth: number;
  parentId?: string;
}

export interface ParsedMermaidGraph {
  nodeLabels: Map<string, string>;
  subgraphs: ParsedMermaidSubgraph[];
  edges: ParsedMermaidEdge[];
}

export interface ParsedMermaidEdge {
  from: string;
  to: string;
}

const NODE_DEF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[([^\]]+)\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\[([^\]]+)\]\)|\(([^)]+)\)|\{([^}]+)\})/g;
const EDGE_ARROW_RE = /(?:--(?:[^>-]+)?-->|-->|-\.(?:[^>-]+)?->|==(?:[^>=]+)?==>)/;
const EDGE_SCAN_RE = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9_]*)\b\s*${EDGE_ARROW_RE.source}\s*\b([A-Za-z][A-Za-z0-9_]*)\b`,
  'g',
);

function parseEdgesFromLine(line: string): ParsedMermaidEdge[] {
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

    searchFrom = match.index + (match[1]?.length ?? 1);
  }

  return edges;
}

/** 解析 Mermaid 流程图中的 subgraph 与节点标签，供导入后创建画板分区。 */
export function parseMermaidGraph(code: string): ParsedMermaidGraph {
  const nodeLabels = new Map<string, string>();
  const subgraphs: ParsedMermaidSubgraph[] = [];
  const edges: ParsedMermaidEdge[] = [];
  const stack: Array<{ id: string; title: string; memberIds: Set<string>; depth: number; parentId?: string }> = [];

  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;

    const subgraphMatch = line.match(/^subgraph\s+(.+)$/i);
    if (subgraphMatch) {
      const parsed = parseSubgraphDeclaration(subgraphMatch[1] ?? '');
      const parent = stack[stack.length - 1];
      stack.push({
        id: parsed.id,
        title: parsed.title,
        memberIds: new Set<string>(),
        depth: stack.length,
        parentId: parent?.id,
      });
      continue;
    }

    if (/^end\s*$/i.test(line)) {
      const current = stack.pop();
      if (current) {
        subgraphs.push({
          id: current.id,
          title: current.title,
          memberIds: [...current.memberIds],
          depth: current.depth,
          parentId: current.parentId,
        });
      }
      continue;
    }

    for (const match of line.matchAll(NODE_DEF_RE)) {
      const nodeId = match[1];
      if (!nodeId) continue;
      const label =
        match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? nodeId;
      nodeLabels.set(nodeId, label.trim());

      const current = stack[stack.length - 1];
      if (current) {
        current.memberIds.add(nodeId);
      }
    }

    for (const edge of parseEdgesFromLine(line)) {
      edges.push(edge);
    }
  }

  return { nodeLabels, subgraphs, edges };
}

function parseSubgraphDeclaration(rest: string): { id: string; title: string } {
  const trimmed = rest.trim();
  const bracketMatch = trimmed.match(/\["([^"]+)"\]|\[([^\]]+)\]/);
  const id = trimmed.split(/\s+/)[0] ?? trimmed;
  if (bracketMatch) {
    return { id, title: (bracketMatch[1] ?? bracketMatch[2] ?? trimmed).trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const tail = parts.slice(1).join(' ').trim();
    return { id, title: tail.replace(/^\[|\]$/g, '').trim() || parts[0]! };
  }

  return { id, title: trimmed.replace(/^\[|\]$/g, '').trim() };
}
