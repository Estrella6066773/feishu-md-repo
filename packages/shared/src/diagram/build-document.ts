import type { LegendEntry } from './types.js';

function formatPrefixCell(prefixes: string[]): string {
  if (prefixes.length === 0) return '—';
  return prefixes.join(' / ');
}

/** 生成图例 Markdown 表格 */
export function buildLegendTable(legend: LegendEntry[]): string {
  const rows = legend.map((entry) => {
    const fill = entry.style.fill;
    const text = entry.style.text;
    const idPrefixes = formatPrefixCell(entry.idPrefixes);
    const labelPrefixes = formatPrefixCell(entry.labelPrefixes);
    return `| ${entry.label} | ${labelPrefixes} | ${idPrefixes} | ${fill} | ${text} |`;
  });

  return [
    '| 类型 | 标签前缀 | 节点 ID 前缀 | 填充色 | 文字色 |',
    '|------|----------|--------------|--------|--------|',
    ...rows,
  ].join('\n');
}

/** 拼装完整 Markdown 文档（标题 + 图例 + 着色图表） */
export function buildDiagramDocument(
  title: string,
  legend: LegendEntry[],
  mermaidCode: string,
): string {
  const safeTitle = title.trim() || '图表';
  const fenceLang = mermaidCode.trim().split('\n')[0]?.trim().toLowerCase().startsWith('mindmap')
    ? 'mermaid'
    : 'mermaid';

  return [
    `# ${safeTitle}`,
    '',
    '## 图例',
    '',
    buildLegendTable(legend),
    '',
    '## 图表',
    '',
    '```' + fenceLang,
    mermaidCode.trim(),
    '```',
    '',
  ].join('\n');
}

/** 导出可复用的模板 Markdown（仅图例与说明，无图表正文） */
export function buildLegendTemplateMarkdown(name: string, legend: LegendEntry[]): string {
  return [
    `# ${name.trim() || '图表模板'}`,
    '',
    '> 图例表供人阅读；在「图表格式化」工具中粘贴本文件可载入下方表格配置。',
    '',
    '## 图例',
    '',
    buildLegendTable(legend),
    '',
  ].join('\n');
}
