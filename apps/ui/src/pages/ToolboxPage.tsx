import { useState } from 'react';
import { DiagramFormatTool } from '@/pages/toolbox/DiagramFormatTool';
import { ExportMarkdownTool } from '@/pages/toolbox/ExportMarkdownTool';

type ToolboxTab = 'export' | 'diagram';

const TABS: Array<{ id: ToolboxTab; label: string; desc: string }> = [
  { id: 'export', label: '文档导出', desc: '飞书云文档 → Markdown' },
  { id: 'diagram', label: '图表格式化', desc: 'Mermaid → 着色文档' },
];

export function ToolboxPage() {
  const [activeTab, setActiveTab] = useState<ToolboxTab>('export');

  return (
    <div className="toolbox-page">
      <div className="toolbox-tabs" role="tablist" aria-label="工具箱">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`toolbox-tab${activeTab === tab.id ? ' toolbox-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="toolbox-tab-label">{tab.label}</span>
            <span className="toolbox-tab-desc">{tab.desc}</span>
          </button>
        ))}
      </div>

      {activeTab === 'export' ? <ExportMarkdownTool /> : <DiagramFormatTool />}
    </div>
  );
}
