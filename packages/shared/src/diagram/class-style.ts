import type { DiagramNodeStyle } from './types.js';

export interface ParsedMermaidClassStyles {
  /** class 名 → 填充、描边、文字色。来自 `classDef`。 */
  styleByClass: Map<string, DiagramNodeStyle>;
  /** 节点 id → class 名。来自 `class id className` 与 `:::className`。 */
  classByNodeId: Map<string, string>;
}

/**
 * 击魄这类语义流程图的固定配色。
 * 飞书画板存不住 class 名，逆向时用填充色找回同一个 class。
 * 各填充色互不重复，只比对 fill 即可。
 */
export const SEMANTIC_FLOW_CLASSES: ReadonlyArray<{ name: string; style: DiagramNodeStyle }> = [
  { name: 'root', style: { fill: '#1a1a1a', text: '#ffffff', border: '#1a1a1a' } },
  { name: 'sys', style: { fill: '#243044', text: '#ffffff', border: '#243044' } },
  { name: 'obj', style: { fill: '#3b7fc4', text: '#ffffff', border: '#2a5f99' } },
  { name: 'cls', style: { fill: '#6eb5d0', text: '#102030', border: '#4e90b0' } },
  { name: 'data', style: { fill: '#f4f6f8', text: '#1c1c1c', border: '#b7c0c8' } },
  { name: 'enum', style: { fill: '#8e6aad', text: '#ffffff', border: '#6d508c' } },
  { name: 'state', style: { fill: '#e4d4f2', text: '#2a2038', border: '#8e6aad' } },
  { name: 'act', style: { fill: '#7ebf8a', text: '#102018', border: '#4e8f5c' } },
  { name: 'asset', style: { fill: '#e39b2e', text: '#1c1408', border: '#b87a16' } },
  { name: 'cfg', style: { fill: '#3e8f55', text: '#ffffff', border: '#2d6a42' } },
  { name: 'tbl', style: { fill: '#b7ddb0', text: '#17331c', border: '#3e8f55' } },
  { name: 'evt', style: { fill: '#d64545', text: '#ffffff', border: '#a33333' } },
  { name: 'ntf', style: { fill: '#f0a8a8', text: '#4a1c1c', border: '#d64545' } },
  { name: 'sub', style: { fill: '#e07a3a', text: '#ffffff', border: '#b85a2c' } },
  { name: 'cond', style: { fill: '#2f7c8a', text: '#ffffff', border: '#1f5a64' } },
  { name: 'logic', style: { fill: '#fff6e0', text: '#3a3018', border: '#e0c98a' } },
];

const SEMANTIC_BY_FILL = new Map(
  SEMANTIC_FLOW_CLASSES.map((entry) => [entry.style.fill, entry]),
);

const CLASS_DEF_RE = /^classDef\s+([A-Za-z][A-Za-z0-9_]*)\s+(.+)$/i;
const CLASS_ASSIGN_RE = /^class\s+(\S.*?)\s+([A-Za-z][A-Za-z0-9_]*)\s*$/i;
const NODE_ID_ON_SHAPE_RE = /\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\[|\[|\(|\{)/g;
const CLASS_SUFFIX_RE = /:::([A-Za-z][A-Za-z0-9_]*)\s*$/;

/** 把 `#abc` / `#AABBCC` 收成小写 `#rrggbb`。不是颜色则返回空串。 */
export function normalizeHexColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const short = trimmed.match(/^#([0-9a-f]{3})$/);
  if (short?.[1]) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const full = trimmed.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (full?.[1]) return `#${full[1]}`;
  return '';
}

function parseClassDefStyle(raw: string): DiagramNodeStyle | null {
  let fill = '';
  let text = '';
  let border = '';
  for (const part of raw.split(',')) {
    const separator = part.indexOf(':');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const hex = normalizeHexColor(part.slice(separator + 1));
    if (!hex) continue;
    if (key === 'fill') fill = hex;
    else if (key === 'color') text = hex;
    else if (key === 'stroke') border = hex;
  }
  if (!fill) return null;
  return { fill, text: text || '#1f2329', border: border || fill };
}

/**
 * 读取 flowchart 里的 `classDef` 与 `class` / `:::class`。
 * 同一节点后出现的 class 行覆盖先前的 `:::`。
 * 飞书 createPlantuml 会丢掉这些行，调用方必须在导入后按这里的结果上色。
 */
export function parseMermaidClassStyles(code: string): ParsedMermaidClassStyles {
  const styleByClass = new Map<string, DiagramNodeStyle>();
  const classByNodeId = new Map<string, string>();

  for (const rawLine of code.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('%%')) continue;

    const classDef = trimmed.match(CLASS_DEF_RE);
    if (classDef?.[1] && classDef[2]) {
      const style = parseClassDefStyle(classDef[2]);
      if (style) styleByClass.set(classDef[1], style);
      continue;
    }

    const assignment = trimmed.match(CLASS_ASSIGN_RE);
    if (assignment?.[1] && assignment[2] && !/^classDef\b/i.test(trimmed)) {
      for (const nodeId of assignment[1].split(',')) {
        const id = nodeId.trim();
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) {
          classByNodeId.set(id, assignment[2]);
        }
      }
      continue;
    }

    const suffix = trimmed.match(CLASS_SUFFIX_RE);
    if (!suffix?.[1]) continue;
    for (const match of trimmed.matchAll(NODE_ID_ON_SHAPE_RE)) {
      const nodeId = match[1];
      if (nodeId) classByNodeId.set(nodeId, suffix[1]);
    }
  }

  return { styleByClass, classByNodeId };
}

/** 填充色命中语义配色时返回 class 名与完整样式；否则返回 null。 */
export function semanticClassByFill(fill: string): { name: string; style: DiagramNodeStyle } | null {
  const hex = normalizeHexColor(fill);
  if (!hex) return null;
  return SEMANTIC_BY_FILL.get(hex) ?? null;
}

/** 写成与源码相同的 `classDef name fill:#,stroke:#,color:#`。 */
export function formatClassDefLine(name: string, style: DiagramNodeStyle): string {
  const border = style.border ?? style.fill;
  return `classDef ${name} fill:${style.fill},stroke:${border},color:${style.text}`;
}
