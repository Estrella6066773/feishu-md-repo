import { classifyNode } from './classify.js';
import { parseMermaidFlowchart } from './parse-mermaid.js';
import type { FormatDiagramWarning, LegendEntry } from './types.js';

const NODE_DEF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[([^\]]+)\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\[([^\]]+)\]\)|\(([^)]+)\)|\{([^}]+)\})/g;

function unescapeLabel(raw: string): string {
  return raw.replace(/<br\s*\/?>/gi, '\n').trim();
}

function buildClassDef(entry: LegendEntry): string {
  const parts = [`fill:${entry.style.fill}`, `color:${entry.style.text}`];
  if (entry.style.border) {
    parts.push(`stroke:${entry.style.border}`);
  }
  return `classDef ${entry.type} ${parts.join(',')}`;
}

function stripExistingClassSuffix(line: string): string {
  return line.replace(/\s*:::\s*[A-Za-z][A-Za-z0-9_]*\s*$/, '');
}

function injectClassOnLine(line: string, nodeId: string, className: string): string {
  const pattern = new RegExp(
    `(\\b${escapeRegExp(nodeId)}\\s*(?:\\[\\[[^\\]]+\\]\\]|\\["[^"]+"\\]|\\[[^\\]]+\\]|\\(\\[[^\\]]+\\]\\)|\\([^)]+\\)|\\{[^}]+\\}))`,
  );
  const stripped = stripExistingClassSuffix(line);
  if (!pattern.test(stripped)) return line;
  return stripped.replace(pattern, `$1:::${className}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface StyleInjectResult {
  code: string;
  warnings: FormatDiagramWarning[];
  matchedCount: number;
  totalNodeCount: number;
}

/** 向 flowchart 源码注入 classDef 与节点 class */
export function injectMermaidStyles(code: string, legend: LegendEntry[]): StyleInjectResult {
  const parsed = parseMermaidFlowchart(code);
  const warnings: FormatDiagramWarning[] = [];
  const nodeClassMap = new Map<string, string>();
  const usedTypes = new Set<string>();
  let matchedCount = 0;

  for (const node of parsed.nodes) {
    const entry = classifyNode(node.id, node.label, legend);
    if (!entry) {
      warnings.push({
        kind: 'unmatched-node',
        message: `节点 ${node.id}（${summarizeLabel(node.label)}）未匹配任何图例`,
      });
      continue;
    }
    nodeClassMap.set(node.id, entry.type);
    usedTypes.add(entry.type);
    matchedCount += 1;
  }

  const outputLines: string[] = [parsed.directiveLine];

  for (const entry of legend) {
    if (usedTypes.has(entry.type)) {
      outputLines.push(`  ${buildClassDef(entry)}`);
    }
  }

  for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex++) {
    let line = parsed.lines[lineIndex] ?? '';
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('%%')) {
      outputLines.push(line);
      continue;
    }

    if (/^(flowchart|graph)\b/i.test(trimmed)) {
      continue;
    }

    if (/^classDef\b/i.test(trimmed) || /^class\b/i.test(trimmed)) {
      continue;
    }

    for (const match of trimmed.matchAll(NODE_DEF_RE)) {
      const nodeId = match[1];
      if (!nodeId) continue;
      const className = nodeClassMap.get(nodeId);
      if (!className) continue;
      line = injectClassOnLine(line, nodeId, className);
    }

    outputLines.push(line);
  }

  return {
    code: outputLines.join('\n').trim(),
    warnings,
    matchedCount,
    totalNodeCount: parsed.nodes.length,
  };
}

function summarizeLabel(label: string): string {
  const singleLine = label.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 40) return singleLine;
  return `${singleLine.slice(0, 37)}…`;
}
