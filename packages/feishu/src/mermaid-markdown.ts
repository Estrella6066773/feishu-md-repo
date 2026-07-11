export type MarkdownDocumentSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'diagram'; code: string; diagramType: number };

/** 飞书 createPlantuml 在 Mermaid 模式下的 diagram_type */
export const MERMAID_DIAGRAM_TYPE = {
  auto: 0,
  mindmap: 1,
  sequence: 2,
  activity: 3,
  class: 4,
  er: 5,
  flowchart: 6,
  usecase: 7,
  component: 8,
} as const;

const FENCED_CODE_RE = /```([^\n]*)\n([\s\S]*?)```/g;

const MERMAID_LANGS = new Set(['mermaid', 'flowchart', 'graph']);

/**
 * 将 Markdown 拆成普通正文与 Mermaid/流程图代码段。
 * 流程图、时序图等会单独成为 diagram 段，同步时写入飞书画板块。
 */
export function splitMarkdownByDiagrams(markdown: string): MarkdownDocumentSegment[] {
  const segments: MarkdownDocumentSegment[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(FENCED_CODE_RE)) {
    const matchIndex = match.index ?? 0;
    const fenceLang = (match[1] ?? '').trim().toLowerCase();
    const code = (match[2] ?? '').trimEnd();
    const fenceBlock = match[0];

    const before = markdown.slice(lastIndex, matchIndex);
    if (before.trim()) {
      segments.push({ kind: 'markdown', content: before });
    }

    if (isDiagramFence(fenceLang, code)) {
      segments.push({
        kind: 'diagram',
        code: normalizeDiagramCode(code, fenceLang),
        diagramType: detectMermaidDiagramType(code, fenceLang),
      });
    } else if (fenceBlock.trim()) {
      segments.push({ kind: 'markdown', content: fenceBlock });
    }

    lastIndex = matchIndex + fenceBlock.length;
  }

  const tail = markdown.slice(lastIndex);
  if (tail.trim()) {
    segments.push({ kind: 'markdown', content: tail });
  }

  if (segments.length === 0) {
    segments.push({ kind: 'markdown', content: markdown });
  }

  return segments;
}

function isDiagramFence(fenceLang: string, code: string): boolean {
  if (MERMAID_LANGS.has(fenceLang)) return true;
  if (fenceLang && fenceLang !== 'mermaid') return false;
  return looksLikeMermaidDiagram(code);
}

function looksLikeMermaidDiagram(code: string): boolean {
  const firstLine = code.trim().split('\n')[0]?.trim().toLowerCase() ?? '';
  return /^(flowchart|graph|sequencediagram|classdiagram|statediagram|erdiagram|journey|gantt|pie|mindmap|timeline|gitgraph|block-beta)\b/.test(
    firstLine,
  );
}

function normalizeDiagramCode(code: string, fenceLang: string): string {
  const trimmed = code.trim();
  if (fenceLang === 'flowchart' || fenceLang === 'graph') {
    const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
    if (!/^flowchart\b/i.test(firstLine) && !/^graph\b/i.test(firstLine)) {
      const direction = fenceLang === 'graph' ? 'TD' : 'LR';
      return `flowchart ${direction}\n${trimmed}`;
    }
  }
  return trimmed;
}

/** 根据 Mermaid 源码首行推断导出时应使用的 fenced 语言标记 */
export function detectDiagramFenceLang(code: string): string {
  const firstLine = code.trim().split('\n')[0]?.trim().toLowerCase() ?? '';
  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph ')) {
    return 'flowchart';
  }
  return 'mermaid';
}

export function detectMermaidDiagramType(code: string, fenceLang: string): number {
  if (fenceLang === 'flowchart' || fenceLang === 'graph') {
    return MERMAID_DIAGRAM_TYPE.flowchart;
  }

  const firstLine = code.trim().split('\n')[0]?.trim().toLowerCase() ?? '';
  if (firstLine.startsWith('mindmap')) return MERMAID_DIAGRAM_TYPE.mindmap;
  if (firstLine.startsWith('sequencediagram')) return MERMAID_DIAGRAM_TYPE.sequence;
  if (firstLine.startsWith('statediagram') || firstLine.startsWith('state ')) {
    return MERMAID_DIAGRAM_TYPE.activity;
  }
  if (firstLine.startsWith('classdiagram')) return MERMAID_DIAGRAM_TYPE.class;
  if (firstLine.startsWith('erdiagram')) return MERMAID_DIAGRAM_TYPE.er;
  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph ')) {
    return MERMAID_DIAGRAM_TYPE.flowchart;
  }
  if (firstLine.startsWith('journey')) return MERMAID_DIAGRAM_TYPE.usecase;

  return MERMAID_DIAGRAM_TYPE.auto;
}

/** 去掉 classDef / :::class，飞书画板 Mermaid 导入通常不支持这些样式语法 */
export function stripMermaidClassStyles(code: string): string {
  return code
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !/^classDef\b/i.test(trimmed) && !/^class\b/i.test(trimmed);
    })
    .map((line) => line.replace(/\s*:::\s*[A-Za-z][A-Za-z0-9_]*\s*$/, ''))
    .join('\n')
    .trim();
}

/**
 * 飞书 createPlantuml（Mermaid）导入前清洗。
 * - 去掉 classDef（飞书不支持，颜色改由导入后给画板块上色）
 * - flowchart → graph（飞书对 graph 识别更稳）
 * - 标签内尖括号 / 非常用数学符号，避免 2891001
 */
export function prepareFeishuMermaidCode(code: string): string {
  let result = stripMermaidClassStyles(code);
  result = result.replace(/<br\s*\/?>/gi, ' ');

  const lines = result.split('\n');
  const firstIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstIdx >= 0) {
    lines[firstIdx] = lines[firstIdx]!.replace(/^\s*flowchart\b/i, 'graph');
  }
  result = lines.join('\n');

  // 仅处理双引号标签内容，避免改动节点形状语法（如 id{决策}）
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, (quoted) =>
    quoted
      .replace(/</g, '＜')
      .replace(/>/g, '＞')
      .replace(/\u2212/g, '-') // −
      .replace(/\u2264/g, '<=') // ≤
      .replace(/\u2265/g, '>=') // ≥
      .replace(/\u00d7/g, 'x') // ×
      .replace(/\u2013|\u2014/g, '-'), // – —
  );
  return result.trim();
}
