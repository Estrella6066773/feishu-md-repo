import {
  DIAGRAM_PRESETS,
  buildLegendTemplateMarkdown,
  buildMindmapThemeCss,
  formatDiagramDocument,
  parseLegendFromMarkdownTable,
  type DiagramOutputMode,
  type DiagramPresetId,
  type LegendEntry,
} from '@feishu-md/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { IconCopy, IconDownload, IconToolbox } from '@/components/icons';
import { appendDiagramToDocument } from '@/lib/queries';

const PRESET_OPTIONS = Object.values(DIAGRAM_PRESETS);

const OUTPUT_MODE_OPTIONS: Array<{ id: DiagramOutputMode; label: string; desc: string }> = [
  { id: 'flowchart-colored', label: '流程图着色', desc: '保留原结构，注入 classDef 配色' },
  { id: 'mindmap', label: '思维导图', desc: '转译为仅发散的树并按图例配色；收束与平行边会丢弃' },
];

const SAMPLE_MERMAID = `flowchart TD
  T["循光之城交互链"]
  R["奖励：靠近指定目标时的从容感"]
  G["目标：向指定目标前进"]
  A["行为：持续向当前章节目标前进"]
  T --> R --> G --> A
  A --> D_route["决策信息：当前章节指定目标是谁"]
  D_route --> O_s1["障碍：被环境吞没"]
  O_s1 --> G_s1["目标：避免脱离可生存带过久"]`;

function cloneLegend(legend: LegendEntry[]): LegendEntry[] {
  return legend.map((entry) => ({
    ...entry,
    labelPrefixes: [...entry.labelPrefixes],
    idPrefixes: [...entry.idPrefixes],
    style: { ...entry.style },
  }));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || '图表文档';
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

/** 仅成品 Mermaid fence，供复制 / 下载 / 飞书画板导入 */
function buildBoardExportMarkdown(mermaidCode: string): string {
  return `\`\`\`mermaid\n${mermaidCode.trim()}\n\`\`\`\n`;
}

export function DiagramFormatTool() {
  const [title, setTitle] = useState('交互链');
  const [mermaidInput, setMermaidInput] = useState('');
  const [outputMode, setOutputMode] = useState<DiagramOutputMode>('flowchart-colored');
  const [presetId, setPresetId] = useState<DiagramPresetId>('interaction-chain');
  const [legend, setLegend] = useState<LegendEntry[]>(() =>
    cloneLegend(DIAGRAM_PRESETS['interaction-chain'].legend),
  );
  const [templatePaste, setTemplatePaste] = useState('');
  const [styledMermaid, setStyledMermaid] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [matchStats, setMatchStats] = useState<{ matched: number; total: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [targetDocumentUrl, setTargetDocumentUrl] = useState('');
  const [isAppending, setIsAppending] = useState(false);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [appendSuccess, setAppendSuccess] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const stats = useMemo(() => {
    if (!styledMermaid) return null;
    return {
      lines: countLines(styledMermaid),
      chars: styledMermaid.length,
    };
  }, [styledMermaid]);

  function applyPreset(nextPresetId: DiagramPresetId) {
    setPresetId(nextPresetId);
    setLegend(cloneLegend(DIAGRAM_PRESETS[nextPresetId].legend));
  }

  function handleLoadTemplate() {
    const parsed = parseLegendFromMarkdownTable(templatePaste);
    if (!parsed) {
      setWarnings(['未能从粘贴内容解析图例表，请确认包含「## 图例」与五列表格']);
      return;
    }
    setLegend(parsed);
    setWarnings([]);
  }

  function handleExportTemplate() {
    const markdown = buildLegendTemplateMarkdown(
      DIAGRAM_PRESETS[presetId]?.name ?? '图表模板',
      legend,
    );
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '图表模板.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function handleFormat() {
    const code = mermaidInput.trim() || SAMPLE_MERMAID;
    const result = formatDiagramDocument({
      title,
      mermaidCode: code,
      legend,
      outputMode,
    });

    setStyledMermaid(result.styledMermaid);
    setWarnings(result.warnings.map((item) => item.message));
    setMatchStats({ matched: result.matchedCount, total: result.totalNodeCount });
    setAppendError(null);
    setAppendSuccess(null);
  }

  function updateLegendRow(index: number, patch: Partial<LegendEntry>) {
    setLegend((rows) =>
      rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  }

  function updateLegendStyle(index: number, patch: Partial<LegendEntry['style']>) {
    setLegend((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, style: { ...row.style, ...patch } } : row,
      ),
    );
  }

  function addLegendRow() {
    setLegend((rows) => [
      ...rows,
      {
        type: `custom_${rows.length + 1}`,
        label: '新类型',
        labelPrefixes: [],
        idPrefixes: [],
        style: { fill: '#f3f4f6', text: '#000000' },
      },
    ]);
  }

  function removeLegendRow(index: number) {
    setLegend((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
  }

  async function handleCopy() {
    if (!styledMermaid) return;
    await navigator.clipboard.writeText(buildBoardExportMarkdown(styledMermaid));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    if (!styledMermaid) return;
    const blob = new Blob([buildBoardExportMarkdown(styledMermaid)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFilename(title)}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleAppendToDocument() {
    if (!styledMermaid) {
      setAppendError('请先完成图表转换');
      return;
    }
    if (!targetDocumentUrl.trim()) {
      setAppendError('请填写目标飞书云文档链接');
      return;
    }

    setIsAppending(true);
    setAppendError(null);
    setAppendSuccess(null);
    try {
      const result = await appendDiagramToDocument(targetDocumentUrl.trim(), styledMermaid);
      const styleNote = result.usedStrippedStyles
        ? '（飞书侧已去掉 classDef 样式以保证导入成功）'
        : '';
      setAppendSuccess(`已在文档末尾追加成品画板${styleNote}`);
    } catch (err) {
      setAppendError(err instanceof Error ? err.message : '导入云文档失败');
    } finally {
      setIsAppending(false);
    }
  }

  useEffect(() => {
    if (!styledMermaid || !previewRef.current) return;

    let cancelled = false;
    setPreviewError(null);

    void (async () => {
      try {
        const mermaid = await import('mermaid');
        const isMindmap = /^\s*mindmap\b/i.test(styledMermaid);
        mermaid.default.initialize({
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'strict',
          flowchart: { htmlLabels: true, curve: 'basis' },
          themeCSS: isMindmap ? buildMindmapThemeCss(legend) : undefined,
        });

        if (cancelled || !previewRef.current) return;

        const renderId = `diagram-preview-${Date.now()}`;
        const { svg } = await mermaid.default.render(renderId, styledMermaid);
        if (!cancelled && previewRef.current) {
          previewRef.current.innerHTML = svg;
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? err.message : '预览渲染失败');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [styledMermaid, legend]);

  const hasResult = Boolean(styledMermaid);

  return (
    <>
      <section className="toolbox-intro">
        <p className="toolbox-intro-lead">
          粘贴 Mermaid flowchart 源码，按可编辑图例着色，或转译为仅发散的思维导图，生成带图例表的 Markdown 文档。
        </p>
        <div className="toolbox-feature-row">
          <div className="toolbox-feature-chip">
            <span className="toolbox-feature-chip-label">图例可配置</span>
            <span className="toolbox-feature-chip-desc">标签前缀、ID 前缀与颜色均可编辑</span>
          </div>
          <div className="toolbox-feature-chip">
            <span className="toolbox-feature-chip-label">模板粘贴</span>
            <span className="toolbox-feature-chip-desc">从含图例表的 Markdown 载入配置</span>
          </div>
          <div className="toolbox-feature-chip">
            <span className="toolbox-feature-chip-label">本地转换</span>
            <span className="toolbox-feature-chip-desc">不依赖飞书凭证，纯浏览器处理</span>
          </div>
        </div>
      </section>

      <div className="toolbox-diagram-workspace">
        <Card className="toolbox-diagram-panel">
          <CardHeader title="输入" description="flowchart / graph 源码；留空转换时使用示例片段" />
          <div className="form-stack">
            <Field label="文档标题">
              <input
                className="field-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="交互链"
              />
            </Field>

            <Field
              label="输出格式"
              hint="思维导图只保留从根向外发散的树；收束、平行与回边会丢弃并提示"
            >
              <div className="toolbox-output-mode-list" role="radiogroup" aria-label="输出格式">
                {OUTPUT_MODE_OPTIONS.map((option) => (
                  <label
                    key={option.id}
                    className={`toolbox-output-mode-option${
                      outputMode === option.id ? ' toolbox-output-mode-option-active' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="diagram-output-mode"
                      value={option.id}
                      checked={outputMode === option.id}
                      onChange={() => setOutputMode(option.id)}
                    />
                    <span className="toolbox-output-mode-text">
                      <span className="toolbox-output-mode-label">{option.label}</span>
                      <span className="toolbox-output-mode-desc">{option.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Mermaid 源码">
              <textarea
                className="field-input toolbox-diagram-textarea"
                value={mermaidInput}
                onChange={(event) => setMermaidInput(event.target.value)}
                placeholder={SAMPLE_MERMAID}
                spellCheck={false}
                rows={14}
              />
            </Field>

            <Button type="button" variant="primary" className="toolbox-submit-btn" onClick={handleFormat}>
              转换为 Markdown 文档
            </Button>
          </div>
        </Card>

        <Card className="toolbox-diagram-panel">
          <CardHeader title="图例配置" description="按节点 ID 前缀或标签前缀匹配类型并着色" />
          <div className="form-stack">
            <Field label="预设">
              <select
                className="field-input"
                value={presetId}
                onChange={(event) => applyPreset(event.target.value as DiagramPresetId)}
              >
                {PRESET_OPTIONS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </Field>

            <div className="toolbox-legend-table-wrap">
              <table className="toolbox-legend-table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>标签前缀</th>
                    <th>ID 前缀</th>
                    <th>填充色</th>
                    <th>文字色</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {legend.map((entry, index) => (
                    <tr key={`${entry.type}-${index}`}>
                      <td>
                        <input
                          className="toolbox-legend-input"
                          value={entry.label}
                          onChange={(event) => updateLegendRow(index, { label: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="toolbox-legend-input"
                          value={entry.labelPrefixes.join(' / ')}
                          onChange={(event) =>
                            updateLegendRow(index, {
                              labelPrefixes: event.target.value
                                .split(/\s*\/\s*/)
                                .map((part) => part.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="目标："
                        />
                      </td>
                      <td>
                        <input
                          className="toolbox-legend-input"
                          value={entry.idPrefixes.join(' / ')}
                          onChange={(event) =>
                            updateLegendRow(index, {
                              idPrefixes: event.target.value
                                .split(/\s*\/\s*/)
                                .map((part) => part.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="G_"
                        />
                      </td>
                      <td>
                        <input
                          className="toolbox-legend-color"
                          type="color"
                          value={entry.style.fill}
                          onChange={(event) => updateLegendStyle(index, { fill: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="toolbox-legend-color"
                          type="color"
                          value={entry.style.text}
                          onChange={(event) => updateLegendStyle(index, { text: event.target.value })}
                        />
                      </td>
                      <td>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeLegendRow(index)}
                          disabled={legend.length <= 1}
                        >
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="action-bar">
              <Button type="button" variant="secondary" size="sm" onClick={addLegendRow}>
                添加类型
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={handleExportTemplate}>
                导出模板
              </Button>
            </div>

            <Field label="粘贴模板 Markdown" hint="含「## 图例」五列表格即可载入">
              <textarea
                className="field-input toolbox-diagram-textarea"
                value={templatePaste}
                onChange={(event) => setTemplatePaste(event.target.value)}
                rows={5}
                spellCheck={false}
              />
            </Field>
            <Button type="button" variant="secondary" size="sm" onClick={handleLoadTemplate}>
              从模板载入图例
            </Button>
          </div>
        </Card>

        <div className="toolbox-diagram-output">
          {warnings.length > 0 ? (
            <Alert tone="warning" title="转换提示">
              <ul className="toolbox-tips-list">
                {warnings.slice(0, 8).map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
                {warnings.length > 8 ? <li>另有 {warnings.length - 8} 条提示未显示</li> : null}
              </ul>
            </Alert>
          ) : null}

          {hasResult ? (
            <>
              <Card className="toolbox-result-card">
                <div className="toolbox-result-header">
                  <div className="toolbox-result-meta">
                    <h2 className="toolbox-result-title">{title}</h2>
                    <div className="toolbox-result-badges">
                      <Badge tone="blue">成品画板</Badge>
                      <Badge>
                        {outputMode === 'mindmap' ? '思维导图' : '流程图着色'}
                      </Badge>
                      {matchStats ? (
                        <Badge>
                          {outputMode === 'mindmap'
                            ? `树节点 ${matchStats.total} · 已着色 ${matchStats.matched}`
                            : `已着色 ${matchStats.matched}/${matchStats.total} 节点`}
                        </Badge>
                      ) : null}
                      {stats ? (
                        <>
                          <Badge>{stats.lines} 行</Badge>
                          <Badge>{stats.chars.toLocaleString()} 字符</Badge>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="action-bar">
                    <Button
                      variant={copied ? 'primary' : 'secondary'}
                      size="sm"
                      icon={<IconCopy />}
                      onClick={handleCopy}
                    >
                      {copied ? '已复制' : '复制图表'}
                    </Button>
                    <Button variant="secondary" size="sm" icon={<IconDownload />} onClick={handleDownload}>
                      下载图表
                    </Button>
                  </div>
                </div>

                {previewError ? (
                  <Alert tone="warning" title="预览不可用">
                    {previewError}
                  </Alert>
                ) : null}

                <div className="toolbox-diagram-preview" ref={previewRef} />

                <div className="toolbox-append-panel form-stack">
                  <CardHeader
                    title="导入到云文档"
                    description="仅在文档末尾追加一块成品画板，不含标题与图例表"
                  />
                  <Field label="目标飞书云文档 URL" hint="支持 feishu.cn/docx 与 feishu.cn/wiki 链接">
                    <input
                      type="url"
                      className="field-input toolbox-url-input"
                      placeholder="https://feishu.cn/docx/xxxxxxxx"
                      value={targetDocumentUrl}
                      onChange={(event) => {
                        setTargetDocumentUrl(event.target.value);
                        setAppendError(null);
                        setAppendSuccess(null);
                      }}
                      disabled={isAppending}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="help-box toolbox-tips">
                    <strong>导入前请确认</strong>
                    <ul className="toolbox-tips-list">
                      <li>已在「设置」中配置飞书应用凭证</li>
                      <li>应用对该文档有编辑权限（含画板节点创建）</li>
                      <li>只追加画板，不会写入图例表，也不会覆盖已有正文</li>
                    </ul>
                  </div>
                  {appendError ? (
                    <Alert tone="danger" title="导入失败">
                      {appendError}
                    </Alert>
                  ) : null}
                  {appendSuccess ? (
                    <Alert tone="success" title="导入成功">
                      {appendSuccess}
                    </Alert>
                  ) : null}
                  <Button
                    type="button"
                    variant="primary"
                    disabled={isAppending || !styledMermaid}
                    onClick={handleAppendToDocument}
                  >
                    {isAppending ? '正在追加画板…' : '追加成品画板到云文档'}
                  </Button>
                </div>
              </Card>
            </>
          ) : (
            <EmptyState
              icon={<IconToolbox className="h-10 w-10" />}
              title="等待转换"
              description="在左侧粘贴 Mermaid 源码、调整图例后点击转换，将生成带图例表与着色图表的 Markdown。"
            />
          )}
        </div>
      </div>
    </>
  );
}
