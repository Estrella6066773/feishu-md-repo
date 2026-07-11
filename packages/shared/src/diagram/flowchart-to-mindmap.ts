import { classifyNode } from './classify.js';
import { parseMermaidFlowchart, type ParsedMermaidEdge, type ParsedMermaidNode } from './parse-mermaid.js';
import type { FormatDiagramWarning, LegendEntry } from './types.js';

export interface FlowchartToMindmapResult {
  code: string;
  warnings: FormatDiagramWarning[];
  keptEdgeCount: number;
  droppedEdgeCount: number;
  totalNodeCount: number;
  matchedCount: number;
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

function buildClassDef(entry: LegendEntry): string {
  const parts = [`fill:${entry.style.fill}`, `color:${entry.style.text}`];
  if (entry.style.border) {
    parts.push(`stroke:${entry.style.border}`);
  }
  return `classDef ${entry.type} ${parts.join(',')}`;
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

function appendTreeLines(
  node: TreeNode,
  depth: number,
  lines: string[],
  legend: LegendEntry[],
  usedTypes: Set<string>,
  unmatched: string[],
): number {
  let matched = 0;
  const entry = legend.length > 0 ? classifyNode(node.id, node.label, legend) : null;
  const classSuffix = entry ? `:::${entry.type}` : '';
  if (entry) {
    usedTypes.add(entry.type);
    matched += 1;
  } else if (legend.length > 0) {
    unmatched.push(`${node.id}（${summarizeLabel(node.label)}）`);
  }

  const indent = '  '.repeat(depth);
  lines.push(`${indent}${escapeMindmapLabel(node.label)}${classSuffix}`);
  for (const child of node.children) {
    matched += appendTreeLines(child, depth + 1, lines, legend, usedTypes, unmatched);
  }
  return matched;
}

/**
 * 将 flowchart 转译为仅允许发散的思维导图树。
 * 收束边（多父入一子）、平行边（同对重复）、自环、回边均丢弃。
 * 若提供 legend，按 ID/标签前缀注入 :::class 与 classDef 配色。
 */
export function flowchartToMindmap(
  code: string,
  options?: { preferredRootId?: string; legend?: LegendEntry[] },
): FlowchartToMindmapResult {
  const parsed = parseMermaidFlowchart(code);
  const warnings: FormatDiagramWarning[] = [];
  const labels = collectNodeLabels(parsed.nodes, parsed.edges);
  const legend = options?.legend ?? [];

  if (labels.size === 0) {
    warnings.push({ kind: 'parse', message: '未解析到任何节点，无法生成思维导图' });
    return {
      code: 'mindmap\n  (空图)',
      warnings,
      keptEdgeCount: 0,
      droppedEdgeCount: 0,
      totalNodeCount: 0,
      matchedCount: 0,
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
      matchedCount: 0,
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
  const convergeSamples: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const outs = childrenByParent.get(current) ?? [];
    for (const childId of outs) {
      if (!labels.has(childId)) continue;

      if (visited.has(childId)) {
        convergeDropped += 1;
        if (convergeSamples.length < 3) {
          convergeSamples.push(
            `${current} → ${childId}（${summarizeLabel(labels.get(childId) ?? childId)}）`,
          );
        }
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

  if (convergeDropped > 0) {
    const sampleText = convergeSamples.join('；');
    const more =
      convergeDropped > convergeSamples.length
        ? `等共 ${convergeDropped} 条`
        : `共 ${convergeDropped} 条`;
    warnings.push({
      kind: 'mindmap-edge-dropped',
      message: `丢弃收束边 ${more}：${sampleText}`,
    });
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
  const usedTypes = new Set<string>();
  const unmatched: string[] = [];
  const matchedCount = appendTreeLines(root, 1, lines, legend, usedTypes, unmatched);

  for (const entry of legend) {
    if (usedTypes.has(entry.type)) {
      lines.push(buildClassDef(entry));
    }
  }

  if (unmatched.length > 0) {
    const sample = unmatched.slice(0, 3).join('；');
    const more =
      unmatched.length > 3 ? `等共 ${unmatched.length} 个` : `共 ${unmatched.length} 个`;
    warnings.push({
      kind: 'unmatched-node',
      message: `未匹配图例 ${more}：${sample}`,
    });
  }

  const droppedEdgeCount =
    selfLoopDropped + parallelDropped + convergeDropped + orphanEdgeDropped;

  return {
    code: lines.join('\n'),
    warnings,
    keptEdgeCount,
    droppedEdgeCount,
    totalNodeCount: visited.size,
    matchedCount,
  };
}

/** 为预览生成 mindmap 节点配色 CSS（Mermaid mindmap 对 classDef 支持不稳定时的兜底） */
export function buildMindmapThemeCss(legend: LegendEntry[]): string {
  return legend
    .map((entry) => {
      const border = entry.style.border ?? entry.style.fill;
      return [
        `.${entry.type} .node-bkg, .${entry.type} > rect, .${entry.type} rect { fill: ${entry.style.fill} !important; stroke: ${border} !important; }`,
        `.${entry.type} .nodeLabel, .${entry.type} span, .${entry.type} foreignObject div { color: ${entry.style.text} !important; fill: ${entry.style.text} !important; }`,
      ].join('\n');
    })
    .join('\n');
}
