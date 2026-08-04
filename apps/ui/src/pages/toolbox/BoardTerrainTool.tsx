import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { IconCopy, IconDownload, IconPlus, IconToolbox } from '@/components/icons';
import { extractBoardTerrain } from '@/lib/queries';

/** 画板识别的指定颜色：RGB(187, 191, 196) = #BBBFC4 */
const DEFAULT_COLORS = ['#BBBFC4'];

interface TerrainShape {
  id: string;
  kind: 'ellipse' | 'rect';
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
}

export function BoardTerrainTool() {
  const [boardUrl, setBoardUrl] = useState('');
  const [colors, setColors] = useState<string[]>(DEFAULT_COLORS);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shapes, setShapes] = useState<TerrainShape[]>([]);
  const [totalNodeCount, setTotalNodeCount] = useState(0);
  const [matchedShapeCount, setMatchedShapeCount] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setError(null);
  }, [boardUrl, colors]);

  function updateColor(index: number, value: string) {
    setColors((rows) => rows.map((row, rowIndex) => (rowIndex === index ? value : row)));
  }

  function addColor() {
    setColors((rows) => [...rows, '#000000']);
  }

  function removeColor(index: number) {
    setColors((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
  }

  async function handleExtract() {
    const url = boardUrl.trim();
    if (!url) {
      setError('请填写飞书画板链接');
      return;
    }
    const validColors = colors.map((item) => item.trim()).filter(Boolean);
    if (validColors.length === 0) {
      setError('请至少保留一个识别颜色');
      return;
    }

    setIsExtracting(true);
    setError(null);
    setShapes([]);
    try {
      const result = await extractBoardTerrain(url, validColors);
      setShapes(result.shapes ?? []);
      setTotalNodeCount(result.totalNodeCount ?? 0);
      setMatchedShapeCount(result.matchedShapeCount ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '地形提取失败');
    } finally {
      setIsExtracting(false);
    }
  }

  function handleDownload() {
    if (shapes.length === 0) return;
    const payload = JSON.stringify(
      {
        whiteboard: boardUrl.trim(),
        colors: colors.map((item) => item.trim()).filter(Boolean),
        totalNodeCount,
        matchedShapeCount,
        shapeCount: shapes.length,
        shapes,
      },
      null,
      2,
    );
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'board-terrain.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleCopyJson() {
    if (shapes.length === 0) return;
    const payload = JSON.stringify(shapes, null, 2);
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const hasResult = shapes.length > 0;
  const ellipseCount = shapes.filter((shape) => shape.kind === 'ellipse').length;
  const rectCount = shapes.filter((shape) => shape.kind === 'rect').length;

  return (
    <>
      <section className="toolbox-intro">
        <p className="toolbox-intro-lead">
          粘贴飞书画板直链，按指定填充色识别其中的圆形与矩形几何体，导出几何体 JSON，供 Unity 侧按预配置墙体预制体复刻地形。
        </p>
        <div className="toolbox-feature-row">
          <div className="toolbox-feature-chip">
            <span className="toolbox-feature-chip-label">形状识别</span>
            <span className="toolbox-feature-chip-desc">椭圆识别为圆，矩形与圆角矩形识别为矩形</span>
          </div>
          <div className="toolbox-feature-chip">
            <span className="toolbox-feature-chip-label">颜色过滤</span>
            <span className="toolbox-feature-chip-desc">仅保留填充色命中的几何体，颜色不映射墙体类型</span>
          </div>
          <div className="toolbox-feature-chip">
            <span className="toolbox-feature-chip-label">JSON 导出</span>
            <span className="toolbox-feature-chip-desc">携带坐标、尺寸与旋转角，供 Unity 复刻</span>
          </div>
        </div>
      </section>

      <div className="toolbox-workspace">
        <Card className="toolbox-diagram-panel">
          <CardHeader title="画板链接与颜色" description="工具运行时从飞书拉取画板节点" />
          <div className="form-stack">
            <Field label="飞书画板/文档链接" hint="支持画板直链（feishu.cn/board），或含画板的云文档链接（docx/wiki）">
              <input
                type="url"
                className="field-input toolbox-url-input"
                placeholder="https://feishu.cn/docx/xxxxxxxx 或 …/board/xxxxxxxx"
                value={boardUrl}
                onChange={(event) => setBoardUrl(event.target.value)}
                disabled={isExtracting}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            <Field label="识别颜色" hint="几何体填充色命中任一颜色即保留">
              <div className="toolbox-terrain-colors">
                {colors.map((color, index) => (
                  <div className="toolbox-terrain-color-row" key={`${index}-${color}`}>
                    <input
                      className="toolbox-legend-color"
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#000000'}
                      onChange={(event) => updateColor(index, event.target.value)}
                      disabled={isExtracting}
                    />
                    <input
                      className="field-input toolbox-terrain-color-text"
                      value={color}
                      onChange={(event) => updateColor(index, event.target.value)}
                      disabled={isExtracting}
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeColor(index)}
                      disabled={isExtracting || colors.length <= 1}
                    >
                      删除
                    </Button>
                  </div>
                ))}
              </div>
            </Field>

            <div className="action-bar">
              <Button type="button" variant="secondary" size="sm" icon={<IconPlus />} onClick={addColor}>
                添加颜色
              </Button>
            </div>

            {error ? (
              <Alert tone="danger" title="提取失败">
                {error}
              </Alert>
            ) : null}

            <Button
              type="button"
              variant="primary"
              className="toolbox-submit-btn"
              disabled={isExtracting}
              onClick={handleExtract}
            >
              {isExtracting ? '正在识别画板…' : '识别地形几何体'}
            </Button>
          </div>
        </Card>

        <div className="toolbox-output-panel">
          {hasResult ? (
            <>
              <Card className="toolbox-result-card">
                <div className="toolbox-result-header">
                  <div className="toolbox-result-meta">
                    <h2 className="toolbox-result-title">识别结果</h2>
                    <div className="toolbox-result-badges">
                      <Badge tone="blue">几何体 {shapes.length}</Badge>
                      <Badge>圆形 {ellipseCount}</Badge>
                      <Badge>矩形 {rectCount}</Badge>
                      <Badge>画板节点 {totalNodeCount}</Badge>
                      <Badge>形状命中 {matchedShapeCount}</Badge>
                    </div>
                  </div>
                  <div className="action-bar">
                    <Button
                      variant={copied ? 'primary' : 'secondary'}
                      size="sm"
                      icon={<IconCopy />}
                      onClick={handleCopyJson}
                    >
                      {copied ? '已复制' : '复制 JSON'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<IconDownload />}
                      onClick={handleDownload}
                    >
                      下载 JSON
                    </Button>
                  </div>
                </div>

                <div className="toolbox-code-panel">
                  <table className="toolbox-terrain-table">
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th>颜色</th>
                        <th>x</th>
                        <th>y</th>
                        <th>宽</th>
                        <th>高</th>
                        <th>旋转</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shapes.map((shape) => (
                        <tr key={shape.id}>
                          <td>{shape.kind === 'ellipse' ? '圆形' : '矩形'}</td>
                          <td>
                            <span className="toolbox-terrain-swatch" style={{ background: shape.color }} />
                            {shape.color}
                          </td>
                          <td>{Math.round(shape.x)}</td>
                          <td>{Math.round(shape.y)}</td>
                          <td>{Math.round(shape.width)}</td>
                          <td>{Math.round(shape.height)}</td>
                          <td>{Math.round(shape.angle)}°</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Alert tone="info" title="下一步">
                  将导出的 JSON 交给 Unity 侧 Editor 工具，即可用 Circle.prefab / Square.prefab 复刻墙体。
                </Alert>
              </Card>
            </>
          ) : (
            <EmptyState
              icon={<IconToolbox className="h-10 w-10" />}
              title="等待识别"
              description="粘贴画板直链、配置识别颜色后点击「识别地形几何体」，将列出圆与矩形的坐标、尺寸与颜色。"
            />
          )}
        </div>
      </div>
    </>
  );
}
