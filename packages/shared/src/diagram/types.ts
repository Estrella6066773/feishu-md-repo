export interface DiagramNodeStyle {
  fill: string;
  text: string;
  border?: string;
}

export interface LegendEntry {
  type: string;
  label: string;
  labelPrefixes: string[];
  idPrefixes: string[];
  style: DiagramNodeStyle;
}

export type DiagramOutputMode = 'flowchart-colored' | 'mindmap';

export interface FormatDiagramOptions {
  title?: string;
  mermaidCode: string;
  legend: LegendEntry[];
  outputMode?: DiagramOutputMode;
}

export interface FormatDiagramWarning {
  kind: 'unmatched-node' | 'mindmap-edge-dropped' | 'parse';
  message: string;
}

export interface FormatDiagramResult {
  markdown: string;
  styledMermaid: string;
  warnings: FormatDiagramWarning[];
  matchedCount: number;
  totalNodeCount: number;
}
