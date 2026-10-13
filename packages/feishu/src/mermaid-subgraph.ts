import {
  parseEdgesFromLine,
  scanMermaidNodeDefs,
  type MermaidNodeFrame,
  type ParsedMermaidEdge,
} from '@feishu-md/shared';

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
  /** `((文案))` 为圆框，`{}` 为菱形框，其余按矩形。创建画板时用它决定外形。 */
  nodeShapes: Map<string, MermaidNodeFrame>;
  subgraphs: ParsedMermaidSubgraph[];
  edges: ParsedMermaidEdge[];
}

/** 解析 Mermaid 流程图中的 subgraph、节点标签和外形，供创建画板时一次写入。 */
export function parseMermaidGraph(code: string): ParsedMermaidGraph {
  const nodeLabels = new Map<string, string>();
  const nodeShapes = new Map<string, MermaidNodeFrame>();
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

    for (const node of scanMermaidNodeDefs(line)) {
      nodeLabels.set(node.id, node.label);
      if (!nodeShapes.has(node.id)) {
        nodeShapes.set(node.id, node.shape);
      }

      const current = stack[stack.length - 1];
      if (current) {
        current.memberIds.add(node.id);
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
