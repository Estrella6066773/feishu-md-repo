import { normalizeMermaidNodeLabel, parseEdgesFromLine, type ParsedMermaidEdge } from '@feishu-md/shared';

export interface ParsedMermaidSubgraph {
  id: string;
  title: string;
  memberIds: string[];
  depth: number;
  parentId?: string;
}

export type { ParsedMermaidEdge };

export interface ParsedMermaidGraph {
  nodeLabels: Map<string, string>;
  /** `{}` 为菱形条件，其余按矩形。分区重建时用它决定画板形状，不依赖飞书导入结果。 */
  nodeShapes: Map<string, 'rect' | 'diamond'>;
  subgraphs: ParsedMermaidSubgraph[];
  edges: ParsedMermaidEdge[];
}

const NODE_DEF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[([^\]]+)\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\[([^\]]+)\]\)|\(([^)]+)\)|\{([^}]+)\})/g;

/** 解析 Mermaid 流程图中的 subgraph 与节点标签，供导入后创建画板分区。 */
export function parseMermaidGraph(code: string): ParsedMermaidGraph {
  const nodeLabels = new Map<string, string>();
  const nodeShapes = new Map<string, 'rect' | 'diamond'>();
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
      const rawLabel =
        match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? nodeId;
      nodeLabels.set(nodeId, normalizeMermaidNodeLabel(rawLabel));
      if (!nodeShapes.has(nodeId)) {
        nodeShapes.set(nodeId, match[7] != null ? 'diamond' : 'rect');
      }

      const current = stack[stack.length - 1];
      if (current) {
        current.memberIds.add(nodeId);
      }
    }

    for (const edge of parseEdgesFromLine(line)) {
      edges.push(edge);
    }
  }

  return { nodeLabels, nodeShapes, subgraphs, edges };
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
