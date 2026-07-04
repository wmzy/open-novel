import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { parseInteractionField, buildSequenceDiagram } from '../../../shared/diagram-builders';
import { pageHeading, loadingWrap } from './viewShared';

const container = css`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const toolbar = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
`;

const fillBtn = css`
  padding: 0.4rem 0.9rem;
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const progressText = css`
  font-size: 0.82rem;
  color: var(--haze-color-text-secondary);
`;

const chapterList = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const chapterItem = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
`;

const chapterHeader = css`
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

const chapterBody = css`
  padding: 0.75rem;
  border-top: 1px solid var(--haze-color-border);
`;

const editBtn = css`
  margin-top: 0.5rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.78rem;
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  cursor: pointer;
`;

const editBox = css`
  width: 100%;
  min-height: 60px;
  margin-top: 0.5rem;
  padding: 0.4rem;
  font-family: monospace;
  font-size: 0.8rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  resize: vertical;
`;

const emptyHint = css`
  font-size: 0.82rem;
  color: var(--haze-color-text-secondary);
  padding: 0.5rem 0;
`;

interface ChapterData {
  number: number;
  title: string;
  interaction: string;
}

interface TimelineResponse {
  timeline: string | null;
  chapters: ChapterData[];
}

interface Props {
  projectId: string;
}

export default function StoryArcView({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [expandedCh, setExpandedCh] = useState<number | null>(null);
  const [editingCh, setEditingCh] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [filling, setFilling] = useState(false);
  const [fillProgress, setFillProgress] = useState('');

  const { data, isLoading } = useQuery<TimelineResponse>({
    queryKey: ['timeline', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/timeline`);
      if (!res.ok) return { timeline: null, chapters: [] };
      return res.json();
    },
  });

  async function handleFill() {
    setFilling(true);
    setFillProgress('启动中...');
    try {
      const res = await fetch(`/api/projects/${projectId}/fill`, { method: 'POST' });
      if (!res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'plan') setFillProgress(`待填 ${evt.total} 章，跳过 ${evt.skipped} 章`);
          else if (evt.type === 'progress') setFillProgress(`已填 ${evt.filled}/${evt.total}（当前第${evt.chapter}章）`);
          else if (evt.type === 'done') {
            setFillProgress(`完成：填 ${evt.filled.length} 章，失败 ${evt.failed.length} 章`);
            queryClient.invalidateQueries({ queryKey: ['timeline', projectId] });
          }
        }
      }
    } catch (e) {
      setFillProgress(`失败：${(e as Error)?.message}`);
    } finally {
      setFilling(false);
    }
  }

  async function handleSaveEdit(chapter: number) {
    const res = await fetch(`/api/projects/${projectId}/interaction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter, interaction: editText }),
    });
    if (res.ok) {
      setEditingCh(null);
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] });
    }
  }

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data) return <div className={loadingWrap}>无法加载故事脉络。</div>;

  return (
    <div className={container}>
      <h3 className={pageHeading}>故事脉络</h3>
      <div className={toolbar}>
        <button className={fillBtn} onClick={handleFill} disabled={filling}>
          {filling ? '生成中...' : '✨ AI 批量生成交互'}
        </button>
        {fillProgress && <span className={progressText}>{fillProgress}</span>}
      </div>
      <CollapsibleDiagram chart={data.timeline} title="全书脉络时间线" />
      <div className={chapterList}>
        {data.chapters.map((ch) => {
          const expanded = expandedCh === ch.number;
          const interactions = parseInteractionField(ch.interaction);
          const seqDiagram = buildSequenceDiagram(interactions);
          const editing = editingCh === ch.number;
          return (
            <div key={ch.number} className={chapterItem}>
              <div className={chapterHeader} onClick={() => setExpandedCh(expanded ? null : ch.number)}>
                {expanded ? '▾' : '▸'} 第{ch.number}章 {ch.title}
              </div>
              {expanded && (
                <div className={chapterBody}>
                  {seqDiagram ? (
                    <>
                      <CollapsibleDiagram chart={seqDiagram} title="角色交互" />
                      {editing ? (
                        <>
                          <textarea
                            className={editBox}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <div>
                            <button className={editBtn} onClick={() => handleSaveEdit(ch.number)}>保存</button>
                            <button className={editBtn} onClick={() => setEditingCh(null)}>取消</button>
                          </div>
                        </>
                      ) : (
                        <button className={editBtn} onClick={() => { setEditingCh(ch.number); setEditText(ch.interaction); }}>
                          ✏️ 编辑
                        </button>
                      )}
                    </>
                  ) : (
                    <div>
                      <div className={emptyHint}>本章无角色交互数据。点击「AI 批量生成交互」或手工编辑。</div>
                      {editing ? (
                        <>
                          <textarea
                            className={editBox}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            placeholder="主动方→被动方[类型]：动作 · ..."
                          />
                          <div>
                            <button className={editBtn} onClick={() => handleSaveEdit(ch.number)}>保存</button>
                            <button className={editBtn} onClick={() => setEditingCh(null)}>取消</button>
                          </div>
                        </>
                      ) : (
                        <button className={editBtn} onClick={() => { setEditingCh(ch.number); setEditText(ch.interaction); }}>
                          ✏️ 手工编辑
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
