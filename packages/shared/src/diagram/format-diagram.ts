import { buildDiagramDocument } from './build-document.js';
import { flowchartToMindmap } from './flowchart-to-mindmap.js';
import { isFlowchartCode } from './parse-mermaid.js';
import { injectMermaidStyles } from './style-inject.js';
import type {
  FormatDiagramOptions,
  FormatDiagramResult,
  FormatDiagramWarning,
} from './types.js';

function ensureFlowchartDirective(code: string): string {
  const trimmed = code.trim();
  if (isFlowchartCode(trimmed)) return trimmed;
  if (/^mindmap\b/i.test(trimmed.split('\n')[0]?.trim() ?? '')) return trimmed;
  return `flowchart TD\n${trimmed}`;
}

/** 将原始 Mermaid 转为带图例与配色的 Markdown 文档 */
export function formatDiagramDocument(options: FormatDiagramOptions): FormatDiagramResult {
  const warnings: FormatDiagramWarning[] = [];
  const outputMode = options.outputMode ?? 'flowchart-colored';
  const title = options.title?.trim() || '图表';
  const legend = options.legend;
  const normalized = ensureFlowchartDirective(options.mermaidCode);

  if (outputMode === 'mindmap') {
    if (/^mindmap\b/i.test(normalized.trim().split('\n')[0]?.trim() ?? '')) {
      return {
        markdown: buildDiagramDocument(title, legend, normalized.trim()),
        styledMermaid: normalized.trim(),
        warnings: [
          {
            kind: 'parse',
            message: '输入已是 mindmap，已原样输出（未再做发散树转译）',
          },
        ],
        matchedCount: 0,
        totalNodeCount: 0,
      };
    }

    const converted = flowchartToMindmap(normalized);
    if (converted.droppedEdgeCount > 0) {
      warnings.push({
        kind: 'mindmap-edge-dropped',
        message: `思维导图仅保留发散树：保留 ${converted.keptEdgeCount} 条边，丢弃 ${converted.droppedEdgeCount} 条收束/平行/不可达边`,
      });
    }

    return {
      markdown: buildDiagramDocument(title, legend, converted.code),
      styledMermaid: converted.code,
      warnings: [...warnings, ...converted.warnings],
      matchedCount: converted.totalNodeCount,
      totalNodeCount: converted.totalNodeCount,
    };
  }

  if (legend.length === 0) {
    warnings.push({ kind: 'parse', message: '图例为空，无法着色' });
    return {
      markdown: buildDiagramDocument(title, legend, normalized),
      styledMermaid: normalized,
      warnings,
      matchedCount: 0,
      totalNodeCount: 0,
    };
  }

  const styled = injectMermaidStyles(normalized, legend);

  return {
    markdown: buildDiagramDocument(title, legend, styled.code),
    styledMermaid: styled.code,
    warnings: [...warnings, ...styled.warnings],
    matchedCount: styled.matchedCount,
    totalNodeCount: styled.totalNodeCount,
  };
}
