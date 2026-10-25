import { useState } from 'react';
import { css } from '@linaria/core';
import { useContextInspector } from '@/web/hooks/useContextInspector';

/** prompt 预览截断长度：检查器只读展示，无需整段加载超长文本。 */
const PROMPT_PREVIEW_CHARS = 4000;

const wrap = css`
  margin: 0.75rem 0 1.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 0.875rem;
  background: var(--haze-color-bg-secondary);
  font-size: 0.8rem;
`;

const toolbar = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

const chapterSelect = css`
  padding: 0.2rem 0.4rem;
  font-size: 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
`;

const totalRow = css`
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
  & strong { color: var(--haze-color-text); }
`;

const barTrack = css`
  height: 8px;
  border-radius: 4px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  overflow: hidden;
  margin-bottom: 0.875rem;
`;

const barFill = css`
  height: 100%;
  background: var(--haze-color-primary);
`;

const sectionTable = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
  th, td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--haze-color-border); vertical-align: middle; }
  th { color: var(--haze-color-text-secondary); font-weight: 500; white-space: nowrap; }
`;

const miniTrack = css`
  width: 120px;
  height: 6px;
  border-radius: 3px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  overflow: hidden;
`;

const miniFill = css`
  height: 100%;
  background: var(--haze-color-primary);
  opacity: 0.75;
`;

const droppedRow = css`
  color: var(--haze-color-text-secondary);
  opacity: 0.65;
  text-decoration: line-through;
`;

const badge = css`
  display: inline-block;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  font-size: 0.7rem;
  white-space: nowrap;
`;

const promptDetails = css`
  margin-top: 0.875rem;
  & summary { cursor: pointer; color: var(--haze-color-text-secondary); }
`;

const promptPre = css`
  margin-top: 0.5rem;
  padding: 0.625rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  line-height: 1.5;
`;

const emptyMsg = css`
  color: var(--haze-color-text-secondary);
`;

interface Props {
  projectId: string;
  /** 已有章节（用于章号下拉；「自动」选项走后端的下一章推断）。 */
  chapters: Array<{ number: number }>;
}

/** 上下文检查器（只读）：写作上下文分层 token 报告 + 预算 + 组装后 prompt 预览。 */
export default function ContextInspectorPanel({ projectId, chapters }: Props) {
  // '' = 自动（下一章，由后端 findNextUnwrittenChapter 推断）
  const [chapter, setChapter] = useState<number | ''>('');
  const { data, isLoading, isError } = useContextInspector(
    projectId,
    chapter === '' ? null : chapter,
    true,
  );

  const pct = data && data.budgetTokens > 0
    ? Math.min(100, Math.round((data.totalTokens / data.budgetTokens) * 100))
    : 0;

  return (
    <div className={wrap}>
      <div className={toolbar}>
        <label htmlFor="context-inspector-chapter">预览章号</label>
        <select
          id="context-inspector-chapter"
          className={chapterSelect}
          value={chapter}
          onChange={(e) => {
            const v = e.target.value;
            setChapter(v === '' ? '' : Number.parseInt(v, 10));
          }}
        >
          <option value="">自动（下一章）</option>
          {chapters.map((c) => (
            <option key={c.number} value={c.number}>第{c.number}章</option>
          ))}
        </select>
        {data && <span>当前预览：第 {data.chapter} 章</span>}
      </div>

      {isLoading && <div className={emptyMsg}>加载分层 token 报告中...</div>}
      {isError && <div className={emptyMsg}>加载失败，请稍后重试。</div>}
      {data && (
        <>
          <div className={totalRow}>
            <strong>总计 {data.totalTokens.toLocaleString()}</strong>
            <span>/ {data.budgetTokens.toLocaleString()} tokens 预算（{pct}%）</span>
          </div>
          <div className={barTrack}>
            <div className={barFill} style={{ width: `${pct}%` }} />
          </div>

          {data.sections.length === 0 ? (
            <div className={emptyMsg}>暂无上下文层——写作阶段的分层上下文为空。</div>
          ) : (
            <table className={sectionTable}>
              <thead>
                <tr>
                  <th>层</th>
                  <th>优先级</th>
                  <th>tokens</th>
                  <th>占比</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data.sections.map((s) => {
                  const width = data.budgetTokens > 0
                    ? Math.min(100, (s.tokens / data.budgetTokens) * 100)
                    : 0;
                  return (
                    <tr key={`${s.name}-${s.priority}`} className={s.kept ? undefined : droppedRow}>
                      <td>{s.name}</td>
                      <td>{s.priority}{s.priority === 0 ? '（硬约束）' : ''}</td>
                      <td>{s.tokens.toLocaleString()}</td>
                      <td>
                        <div className={miniTrack}>
                          <div className={miniFill} style={{ width: `${width}%` }} />
                        </div>
                      </td>
                      <td>
                        {!s.kept
                          ? <span className={badge}>已丢弃</span>
                          : s.truncatedTo !== undefined
                            ? <span className={badge}>截断至 {s.truncatedTo} 字</span>
                            : <span className={badge}>保留</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <details className={promptDetails}>
            <summary>查看组装后 prompt（前 {PROMPT_PREVIEW_CHARS.toLocaleString()} 字符）</summary>
            <pre className={promptPre}>
              {data.prompt.length > PROMPT_PREVIEW_CHARS
                ? `${data.prompt.slice(0, PROMPT_PREVIEW_CHARS)}\n\n……（仅展示前 ${PROMPT_PREVIEW_CHARS.toLocaleString()} 字符，共 ${data.prompt.length.toLocaleString()} 字符）`
                : data.prompt}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
