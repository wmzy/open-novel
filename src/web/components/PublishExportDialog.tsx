import { useCallback, useEffect, useState } from 'react';
import { css } from '@linaria/core';
import { toast } from 'sonner';
import { PUBLISH_RULES, PUBLISH_TARGETS, type PublishTarget } from '@/shared/publish-formats';

/**
 * 「平台发布」对话框：起点/番茄/七猫/晋江纯文本导出 + 全本敏感词扫描。
 *
 * 自包含组件（自己拉章节列表与导出结果），接线点（ProjectPage 导出菜单内）：
 *   const [showPublish, setShowPublish] = useState(false);
 *   <button onClick={() => setShowPublish(true)}>平台文本 / 敏感词</button>
 *   {showPublish && (
 *     <PublishExportDialog
 *       projectId={id}
 *       projectTitle={project.title}
 *       onClose={() => setShowPublish(false)}
 *       onOpenChapter={(n) => 跳写作视图并选中第 n 章}
 *     />
 *   )}
 * onOpenChapter 不传时样本仅展示章号，不渲染跳转按钮。
 */

interface Props {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
  /** 点击命中样本时跳转章节（由父页面接线；未提供则不显示跳转）。 */
  onOpenChapter?: (chapter: number) => void;
}

interface ChapterRow {
  number: number;
  title: string | null;
}

interface ScanSample {
  chapter: number | null;
  index: number;
  context: string;
}

interface ScanHit {
  word: string;
  count: number;
  samples: ScanSample[];
}

interface ScanResponse {
  totalHits: number;
  hits: ScanHit[];
  extraWordCount: number;
  chapterCounts: Array<{ chapter: number; count: number }>;
  warnings: string[];
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const dialog = css`
  background: var(--haze-color-bg, #fff);
  border-radius: 8px;
  padding: 1.5rem;
  width: 560px;
  max-width: 90vw;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
`;

const titleCls = css`
  margin: 0 0 1rem;
  font-size: 1.1rem;
`;

const section = css`
  border-top: 1px solid var(--haze-color-border, #e5e7eb);
  padding-top: 1rem;
  margin-top: 1rem;
`;

const sectionTitle = css`
  font-size: 0.9rem;
  font-weight: 600;
  margin: 0;
`;

const row = css`
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
`;

const btn = css`
  padding: 0.4rem 1rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const primaryBtn = css`
  padding: 0.4rem 1rem;
  border: 1px solid var(--haze-color-primary, #3b82f6);
  border-radius: 6px;
  background: var(--haze-color-primary, #3b82f6);
  color: white;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const select = css`
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.85rem;
`;

const hint = css`
  font-size: 0.78rem;
  color: var(--haze-color-text-secondary, #6b7280);
  margin: 0.5rem 0 0;
`;

const hitList = css`
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
`;

const hitItem = css`
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
  font-size: 0.82rem;
`;

const hitWord = css`
  font-weight: 600;
  color: #dc2626;
  margin-right: 0.5rem;
`;

const sampleItem = css`
  margin: 0.25rem 0 0;
  color: var(--haze-color-text-secondary, #4b5563);
`;

const sampleJump = css`
  background: none;
  border: none;
  padding: 0;
  margin-right: 0.35rem;
  color: var(--haze-color-primary, #3b82f6);
  cursor: pointer;
  font-size: 0.78rem;
  text-decoration: underline;
`;

const emptyMsg = css`
  color: var(--haze-color-text-secondary, #6b7280);
  font-size: 0.82rem;
  margin: 0.5rem 0 0;
`;

const actions = css`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
`;

/** 解析 Content-Disposition：优先 RFC 5987 filename*（UTF-8），回退 filename。 */
function parseDispositionFilename(disposition: string): string | null {
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch { /* fallthrough */ }
  }
  const plain = disposition.match(/filename="([^"]+)"/)?.[1];
  return plain ?? null;
}

export default function PublishExportDialog({ projectId, projectTitle, onClose, onOpenChapter }: Props) {
  const [target, setTarget] = useState<PublishTarget>('qidian');
  const [chapter, setChapter] = useState<string>('all');
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [exporting, setExporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/chapters`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('加载章节失败'))))
      .then((data: { chapters: ChapterRow[] }) => {
        if (!cancelled) setChapters(data.chapters);
      })
      .catch(() => { /* 章节列表加载失败时仍可导出全本 */ });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const fetchPublishText = useCallback(async (): Promise<{ text: string; filename: string } | null> => {
    const qs = new URLSearchParams({ target });
    if (chapter !== 'all') qs.set('chapter', chapter);
    const res = await fetch(`/api/projects/${projectId}/export/publish?${qs}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error((data as { error?: string }).error || '导出失败');
      return null;
    }
    const warnHeader = res.headers.get('x-export-warnings');
    if (warnHeader) toast.warning(decodeURIComponent(warnHeader));
    const filename = parseDispositionFilename(res.headers.get('content-disposition') ?? '')
      ?? `${projectTitle}-${target}.txt`;
    return { text: await res.text(), filename };
  }, [chapter, projectId, projectTitle, target]);

  const handleDownload = async () => {
    setExporting(true);
    try {
      const result = await fetchPublishText();
      if (!result) return;
      const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('已导出平台文本');
    } catch {
      toast.error('导出失败');
    } finally {
      setExporting(false);
    }
  };

  const handleCopy = async () => {
    setExporting(true);
    try {
      const result = await fetchPublishText();
      if (!result) return;
      await navigator.clipboard.writeText(result.text);
      toast.success(`已复制到剪贴板（${result.text.length} 字），可直接粘贴到${PUBLISH_RULES[target].label}发布框`);
    } catch {
      toast.error('复制失败（浏览器可能未授权剪贴板）');
    } finally {
      setExporting(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export/sensitive-scan`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((data as { error?: string }).error || '扫描失败');
        return;
      }
      setScan(data as ScanResponse);
      if ((data as ScanResponse).totalHits === 0) {
        toast.success('未命中敏感词');
      }
    } catch {
      toast.error('扫描失败');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={dialog}>
        <h3 className={titleCls}>平台发布 · {projectTitle}</h3>

        <div className={row}>
          <label htmlFor="publish-target">平台</label>
          <select
            id="publish-target"
            className={select}
            value={target}
            onChange={(e) => setTarget(e.target.value as PublishTarget)}
          >
            {PUBLISH_TARGETS.map((t) => (
              <option key={t} value={t}>{PUBLISH_RULES[t].label}</option>
            ))}
          </select>
          <label htmlFor="publish-chapter">范围</label>
          <select
            id="publish-chapter"
            className={select}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
          >
            <option value="all">全本（合并）</option>
            {chapters.map((ch) => (
              <option key={ch.number} value={String(ch.number)}>
                第{ch.number}章{ch.title ? ` ${ch.title}` : ''}
              </option>
            ))}
          </select>
          <button className={primaryBtn} onClick={handleDownload} disabled={exporting}>
            {exporting ? '处理中...' : '下载 TXT'}
          </button>
          <button className={btn} onClick={handleCopy} disabled={exporting}>
            复制文本
          </button>
        </div>
        <p className={hint}>
          纯文本无 markdown 标记与段首缩进，按{PUBLISH_RULES[target].label}排版约定生成，可直接粘贴到发布框。
        </p>

        <div className={section}>
          <div className={row}>
            <h4 className={sectionTitle}>敏感词扫描</h4>
            <button className={btn} onClick={handleScan} disabled={scanning}>
              {scanning ? '扫描中...' : '扫描全本'}
            </button>
          </div>
          <p className={hint}>
            内置默认词表 + 项目级 .novel/sensitive-words.txt（每行一词，# 注释）合并扫描。
          </p>
          {scan && (
            scan.totalHits === 0
              ? <p className={emptyMsg}>未命中敏感词，可以放心发布。</p>
              : (
                <>
                  <p className={hint}>
                    共 {scan.totalHits} 处命中，{scan.hits.length} 个词
                    {scan.extraWordCount > 0 ? `（含自定义词 ${scan.extraWordCount} 条）` : ''}：
                  </p>
                  <ul className={hitList}>
                    {scan.hits.map((hit) => (
                      <li key={hit.word} className={hitItem}>
                        <span className={hitWord}>{hit.word}</span>
                        <span>{hit.count} 处</span>
                        {hit.samples.map((sample, i) => (
                          <p key={i} className={sampleItem}>
                            {sample.chapter !== null && onOpenChapter
                              ? (
                                <button
                                  className={sampleJump}
                                  onClick={() => onOpenChapter(sample.chapter as number)}
                                  title="跳转到该章"
                                >
                                  第{sample.chapter}章
                                </button>
                              )
                              : sample.chapter !== null ? `第${sample.chapter}章：` : ''}
                            …{sample.context}…
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </>
              )
          )}
        </div>

        <div className={actions}>
          <button className={btn} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
