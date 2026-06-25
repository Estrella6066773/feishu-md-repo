import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { LoadingBlock } from '@/components/ui/Spinner';
import { IconCopy, IconDownload, IconToolbox } from '@/components/icons';
import { exportDocumentToMarkdown } from '@/lib/queries';

const FEATURES = [
  { label: '云文档正文', desc: '标题、段落、列表、代码块' },
  { label: '画板思维导图', desc: '还原为 Mermaid mindmap' },
  { label: '单篇导出', desc: '不递归子文档，保留原文链接' },
] as const;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || '导出文档';
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

export function ToolboxPage() {
  const [documentUrl, setDocumentUrl] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    if (!markdown) return null;
    return {
      lines: countLines(markdown),
      chars: markdown.length,
    };
  }, [markdown]);

  async function handleExport(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMarkdown('');
    setTitle('');
    setCopied(false);

    if (!documentUrl.trim()) {
      setError('请输入飞书云文档链接');
      return;
    }

    setIsLoading(true);
    try {
      const result = await exportDocumentToMarkdown(documentUrl.trim());
      setMarkdown(result.markdown);
      setTitle(result.title ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopy() {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFilename(title)}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const hasResult = Boolean(markdown);
  const showEmpty = !isLoading && !hasResult && !error;

  return (
    <div className="toolbox-page">
      <section className="toolbox-intro">
        <p className="toolbox-intro-lead">
          粘贴一篇已整理好的飞书云文档链接，将正文与内嵌画板思维导图逆向转译为 Markdown。
        </p>
        <div className="toolbox-feature-row">
            {FEATURES.map((feature) => (
              <div key={feature.label} className="toolbox-feature-chip">
                <span className="toolbox-feature-chip-label">{feature.label}</span>
                <span className="toolbox-feature-chip-desc">{feature.desc}</span>
              </div>
            ))}
        </div>
      </section>

      <div className="toolbox-workspace">
        <Card className="toolbox-input-card">
          <form onSubmit={handleExport} className="form-stack">
            <CardHeader
              title="文档链接"
              description="支持 feishu.cn/docx 与 feishu.cn/wiki 链接"
            />

            <Field label="飞书云文档 URL" hint="仅导出这一篇文档，不会跟随文内链接递归拉取">
              <input
                type="url"
                className="field-input toolbox-url-input"
                placeholder="https://feishu.cn/docx/xxxxxxxx"
                value={documentUrl}
                onChange={(event) => setDocumentUrl(event.target.value)}
                disabled={isLoading}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            <div className="help-box toolbox-tips">
              <strong>使用前请确认</strong>
              <ul className="toolbox-tips-list">
                <li>已在「设置」中配置飞书应用凭证</li>
                <li>应用对该文档有读取权限（含画板节点读取）</li>
                <li>待导出内容已集中在这篇文档内</li>
              </ul>
            </div>

            <Button type="submit" variant="primary" className="toolbox-submit-btn" disabled={isLoading}>
              {isLoading ? '正在导出…' : '导出 Markdown'}
            </Button>
          </form>
        </Card>

        <div className="toolbox-output-panel">
          {error ? (
            <Alert tone="danger" title="导出失败">
              {error}
            </Alert>
          ) : null}

          {isLoading ? (
            <Card>
              <LoadingBlock label="正在读取文档结构与画板节点…" />
            </Card>
          ) : hasResult ? (
            <Card className="toolbox-result-card">
              <div className="toolbox-result-header">
                <div className="toolbox-result-meta">
                  <h2 className="toolbox-result-title">{title || '导出结果'}</h2>
                  <div className="toolbox-result-badges">
                    <Badge tone="blue">Markdown</Badge>
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
                    {copied ? '已复制' : '复制全文'}
                  </Button>
                  <Button variant="secondary" size="sm" icon={<IconDownload />} onClick={handleDownload}>
                    下载 .md
                  </Button>
                </div>
              </div>

              <div className="toolbox-code-panel">
                <pre className="toolbox-code-pre">
                  <code>{markdown}</code>
                </pre>
              </div>
            </Card>
          ) : showEmpty ? (
            <EmptyState
              icon={<IconToolbox className="h-10 w-10" />}
              title="等待导出"
              description="在左侧粘贴飞书云文档链接并点击导出，Markdown 结果将显示在这里，可复制或下载保存。"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
