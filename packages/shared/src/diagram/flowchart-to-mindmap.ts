import { parseMermaidFlowchart, type ParsedMermaidEdge, type ParsedMermaidNode } from './parse-mermaid.js';
import type { FormatDiagramWarning } from './types.js';

export interface FlowchartToMindmapResult {
  code: string;
  warnings: FormatDiagramWarning[];
  keptEdgeCount: number;
  droppedEdgeCount: number;
  totalNodeCount: number;
}

interface TreeNode {
  id: string;
  label: string;
  children: TreeNode[];
}

function escapeMindmapLabel(label: string): string {
  const singleLine = label.replace(/\s+/g, ' ').trim() || '节点';
  const escaped = singleLine.replace(/]/g, '］').replace(/\[/g, '［');
  return `(${escaped})`;
}

function summarizeLabel(label: string): string {
  const singleLine = label.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 40) return singleLine;
  return `${singleLine.slice(0, 37)}…`;
}

function collectNodeLabels(
  nodes: ParsedMermaidNode[],
  edges: ParsedMermaidEdge[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const node of nodes) {
    labels.set(node.id, node.label);
  }
  for (const edge of edges) {
    if (!labels.has(edge.from)) labels.set(edge.from, edge.from);
    if (!labels.has(edge.to)) labels.set(edge.to, edge.to);
  }
  return labels;
}

function pickRoot(
  labels: Map<string, string>,
  edges: ParsedMermaidEdge[],
  preferredRootId?: string,
): string | null {
  if (labels.size === 0) return null;

  if (preferredRootId && labels.has(preferredRootId)) {
    return preferredRootId;
  }

  for (const id of labels.keys()) {
    if (id === 'T' || id.startsWith('T_')) return id;
  }

  const inDegree = new Map<string, number>();
  for (const id of labels.keys()) inDegree.set(id, 0);
  for (const edge of edges) {
    if (!labels.has(edge.from) || !labels.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  for (const [id, degree] of inDegree) {
    if (degree === 0) return id;
  }

  return labels.keys().next().value ?? null;
}

function appendTreeLines(node: TreeNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  lines.push(`${indent}${escapeMindmapLabel(node.label)}`);
  for (const child of node.children) {
    appendTreeLines(child, depth + 1, lines);
  }
}

/**
 * 将 flowchart 转译为仅允许发散的思维导图树。
 * 收束边（多父入一子）、平行边（同对重复）、自环、回边均丢弃。
 */
export function flowchartToMindmap(
  code: string,
  options?: { preferredRootId?: string },
): FlowchartToMindmapResult {
  const parsed = parseMermaidFlowchart(code);
  const warnings: FormatDiagramWarning[] = [];
  const labels = collectNodeLabels(parsed.nodes, parsed.edges);

  if (labels.size === 0) {
    warnings.push({ kind: 'parse', message: '未解析到任何节点，无法生成思维导图' });
    return {
      code: 'mindmap\n  (空图)',
      warnings,
      keptEdgeCount: 0,
      droppedEdgeCount: 0,
      totalNodeCount: 0,
    };
  }

  const rootId = pickRoot(labels, parsed.edges, options?.preferredRootId);
  if (!rootId) {
    warnings.push({ kind: 'parse', message: '无法确定思维导图根节点' });
    return {
      code: 'mindmap\n  (空图)',
      warnings,
      keptEdgeCount: 0,
      droppedEdgeCount: parsed.edges.length,
      totalNodeCount: labels.size,
    };
  }

  const seenPairs = new Set<string>();
  const uniqueEdges: ParsedMermaidEdge[] = [];
  let parallelDropped = 0;
  let selfLoopDropped = 0;

  for (const edge of parsed.edges) {
    if (edge.from === edge.to) {
      selfLoopDropped += 1;
      warnings.push({
        kind: 'mindmap-edge-dropped',
        message: `丢弃自环：${edge.from} → ${edge.to}`,
      });
      continue;
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenPairs.has(key)) {
      parallelDropped += 1;
      continue;
    }
    seenPairs.add(key);
    uniqueEdges.push(edge);
  }

  if (parallelDropped > 0) {
    warnings.push({
      kind: 'mindmap-edge-dropped',
      message: `丢弃 ${parallelDropped} 条平行边（同一对节点的重复连接）`,
    });
  }

  const childrenByParent = new Map<string, string[]>();
  for (const edge of uniqueEdges) {
    const list = childrenByParent.get(edge.from) ?? [];
    list.push(edge.to);
    childrenByParent.set(edge.from, list);
  }

  const treeChildren = new Map<string, string[]>();
  const queue: string[] = [rootId];
  const visited = new Set<string>([rootId]);
  let keptEdgeCount = 0;
  let convergeDropped = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const outs = childrenByParent.get(current) ?? [];
    for (const childId of outs) {
      if (!labels.has(childId)) continue;

      if (visited.has(childId)) {
        convergeDropped += 1;
        warnings.push({
          kind: 'mindmap-edge-dropped',
          message: `丢弃收束边：${current} → ${childId}（${summarizeLabel(labels.get(childId) ?? childId)} 已有父节点）`,
        });
        continue;
      }

      visited.add(childId);
      const siblings = treeChildren.get(current) ?? [];
      siblings.push(childId);
      treeChildren.set(current, siblings);
      keptEdgeCount += 1;
      queue.push(childId);
    }
  }

  const unreachable: string[] = [];
  for (const id of labels.keys()) {
    if (!visited.has(id)) unreachable.push(id);
  }
  if (unreachable.length > 0) {
    warnings.push({
      kind: 'mindmap-edge-dropped',
      message: `有 ${unreachable.length} 个节点无法从根「${summarizeLabel(labels.get(rootId) ?? rootId)}」到达，未纳入思维导图`,
    });
  }

  // 源不在树上的边（孤立分量内的边）
  let orphanEdgeDropped = 0;
  for (const edge of uniqueEdges) {
    if (!visited.has(edge.from)) {
      orphanEdgeDropped += 1;
    }
  }

  function buildTree(id: string): TreeNode {
    const childIds = treeChildren.get(id) ?? [];
    return {
      id,
      label: labels.get(id) ?? id,
      children: childIds.map(buildTree),
    };
  }

  const root = buildTree(rootId);
  const lines: string[] = ['mindmap'];
  appendTreeLines(root, 1, lines);

  const droppedEdgeCount =
    selfLoopDropped + parallelDropped + convergeDropped + orphanEdgeDropped;

  return {
    code: lines.join('\n'),
    warnings,
    keptEdgeCount,
    droppedEdgeCount,
    totalNodeCount: visited.size,
  };
}
