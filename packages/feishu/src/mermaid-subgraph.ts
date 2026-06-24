export interface ParsedMermaidSubgraph {
  title: string;
  memberIds: string[];
  depth: number;
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
const EDGE_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\b\s*(?:--(?:[^>-]+)?-->|-->|-\.(?:[^>-]+)?->|==(?:[^>=]+)?==>)\s*\b([A-Za-z][A-Za-z0-9_]*)\b/g;

/** 解析 Mermaid 流程图中的 subgraph 与节点标签，供导入后创建画板分区。 */
export function parseMermaidGraph(code: string): ParsedMermaidGraph {
  const nodeLabels = new Map<string, string>();
  const subgraphs: ParsedMermaidSubgraph[] = [];
  const edges: ParsedMermaidEdge[] = [];
  const stack: Array<{ title: string; memberIds: Set<string>; depth: number }> = [];

  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;

    const subgraphMatch = line.match(/^subgraph\s+(.+)$/i);
    if (subgraphMatch) {
      stack.push({
        title: parseSubgraphTitle(subgraphMatch[1] ?? ''),
        memberIds: new Set<string>(),
        depth: stack.length,
      });
      continue;
    }

    if (/^end\s*$/i.test(line)) {
      const current = stack.pop();
      if (current) {
        subgraphs.push({
          title: current.title,
          memberIds: [...current.memberIds],
          depth: current.depth,
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

    for (const match of line.matchAll(EDGE_RE)) {
      const from = match[1];
      const to = match[2];
      if (from && to) {
        edges.push({ from, to });
      }
    }
  }

  return { nodeLabels, subgraphs, edges };
}

function parseSubgraphTitle(rest: string): string {
  const trimmed = rest.trim();
  const bracketMatch = trimmed.match(/\["([^"]+)"\]|\[([^\]]+)\]/);
  if (bracketMatch) {
    return (bracketMatch[1] ?? bracketMatch[2] ?? trimmed).trim();
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const tail = parts.slice(1).join(' ').trim();
    return tail.replace(/^\[|\]$/g, '').trim() || parts[0]!;
  }

  return trimmed.replace(/^\[|\]$/g, '').trim();
}
