import { useEffect, useState } from 'react';
import { css } from '@linaria/core';
import { EntityMarkdown } from './EntityMarkdown';
import { useEntityDict } from '@/web/hooks/useEntityDict';

const container = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
  height: 100%;
  display: flex;
  flex-direction: column;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--haze-color-bg-secondary);
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  font-family: var(--haze-font-mono);
  color: var(--haze-color-text-secondary);
`;

const rawContent = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  font-family: var(--haze-font-mono);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--haze-color-text);
`;

const mdContent = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--haze-color-text);
`;

const toggleBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  &:hover { background: var(--haze-color-border); }
`;

/** 影响分析按钮（与源码切换按钮同款，禁用态置灰）。 */
const retroBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  &:hover:not(:disabled) { background: var(--haze-color-border); }
  &:disabled { opacity: 0.5; cursor: default; }
`;

/** 影响分析结果摘要条（成功后短暂展示，失败静默不渲染）。 */
const retroBar = css`
  padding: 0.375rem 0.75rem;
  background: var(--haze-color-bg-secondary);
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
`;

/** 工具栏按钮组。 */
const toolbar = css`
  display: flex;
  gap: 0.375rem;
`;

const emptyState = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
`;

interface Props {
  projectId: string;
  filePath: string | null;
  content: string | null;
  loading?: boolean;
}

export default function FilePreview({ projectId, filePath, content, loading }: Props) {
  const [raw, setRaw] = useState(false);
  const { dict } = useEntityDict(projectId);
  // 影响分析：busy 运行中；msg 成功摘要（失败静默降级，不展示任何错误）
  const [retroBusy, setRetroBusy] = useState(false);
  const [retroMsg, setRetroMsg] = useState<string | null>(null);

  // 切换预览文件时清掉上一次的影响分析提示
  useEffect(() => {
    setRetroMsg(null);
  }, [filePath]);

  // 成功提示 8 秒后自动消失
  useEffect(() => {
    if (!retroMsg) return;
    const timer = window.setTimeout(() => setRetroMsg(null), 8000);
    return () => window.clearTimeout(timer);
  }, [retroMsg]);

  /** 对当前预览文件发起回溯影响分析，成功展示影响计数摘要，失败静默降级。 */
  async function runRetroAnalysis() {
    if (!filePath || retroBusy) return;
    setRetroBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/retro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath }),
      });
      if (!res.ok) throw new Error(`retro ${res.status}`);
      const data = await res.json();
      const parts: string[] = [];
      if (Array.isArray(data.chapters) && data.chapters.length > 0) {
        parts.push(`章节 ${data.chapters.length}`);
      }
      if (Array.isArray(data.outlines) && data.outlines.length > 0) {
        parts.push(`大纲 ${data.outlines.length}`);
      }
      if (Array.isArray(data.foreshadows) && data.foreshadows.length > 0) {
        parts.push(`伏笔 ${data.foreshadows.length}`);
      }
      const detail = parts.length > 0 ? `影响面：${parts.join('，')}` : '未扫描到受影响面';
      setRetroMsg(`${detail}（报告：${data.reportPath ?? ''}）`);
    } catch {
      // 静默降级：影响分析不可用时不打扰预览
    } finally {
      setRetroBusy(false);
    }
  }

  if (!filePath) {
    return (
      <div className={container}>
        <div className={emptyState}>选择文件以预览</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={container}>
        <div className={header}>{filePath}</div>
        <div className={emptyState}>加载中...</div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className={container}>
        <div className={header}>{filePath}</div>
        <div className={emptyState}>文件未找到</div>
      </div>
    );
  }

  const isMarkdown = filePath.endsWith('.md');

  return (
    <div className={container}>
      <div className={header}>
        <span>{filePath}</span>
        <div className={toolbar}>
          <button
            className={retroBtn}
            onClick={runRetroAnalysis}
            disabled={retroBusy}
            title="扫描该设定文件修订后受影响的章节/大纲/伏笔"
          >
            {retroBusy ? '分析中…' : '影响分析'}
          </button>
          {isMarkdown && (
            <button className={toggleBtn} onClick={() => setRaw(!raw)}>
              {raw ? '预览' : '源码'}
            </button>
          )}
        </div>
      </div>
      {retroMsg && <div className={retroBar}>{retroMsg}</div>}
      {isMarkdown && !raw ? (
        <div className={mdContent}>
          <EntityMarkdown content={content} dict={dict} projectId={projectId} />
        </div>
      ) : (
        <div className={rawContent}>{content}</div>
      )}
    </div>
  );
}
