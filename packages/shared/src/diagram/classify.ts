import type { LegendEntry } from './types.js';

/** 根据节点 ID 与标签文本匹配图例条目（ID 前缀优先） */
export function classifyNode(
  nodeId: string,
  label: string,
  legend: LegendEntry[],
): LegendEntry | null {
  for (const entry of legend) {
    for (const prefix of entry.idPrefixes) {
      if (prefix && nodeId.startsWith(prefix)) {
        return entry;
      }
    }
  }

  const normalizedLabel = label.trim();
  for (const entry of legend) {
    for (const prefix of entry.labelPrefixes) {
      if (prefix && normalizedLabel.startsWith(prefix)) {
        return entry;
      }
    }
  }

  return null;
}
