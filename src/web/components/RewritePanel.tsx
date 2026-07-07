import { useState, useRef, useEffect, useCallback } from 'react';
import { css } from '@linaria/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRewrite } from '@/web/hooks/useRewrite';

// ---- 样式 ----
const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const toolbar = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const toolbarLeft = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
`;

const toolbarRight = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const statusLabel = css`
  font-size: 0.7rem;
  padding: 0.125rem 0.5rem;
  border-radius: 10px;
  font-weight: 500;
  color: #fff;
`;

const statusSelect = css`
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.375rem;
  font-size: 0.7rem;
  cursor: pointer;
  &:focus { outline: none; }
`;

const body = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const sectionTitle = css`
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  margin: 0;
`;

const textarea = css`
  width: 100%;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.75rem;
  resize: vertical;
  font-family: var(--haze-font-mono);
  font-size: 0.875rem;
  line-height: 1.7;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  min-height: 180px;
  &:focus { outline: none; border-color: var(--haze-color-primary); }
`;

const hint = css`
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary);
`;

const hintWarn = css`
  color: var(--haze-color-warning, #f59e0b);
`;

const presetGrid = css`
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
`;

const presetBtn = css`
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  cursor: pointer;
  color: var(--haze-color-text);
  &:hover { background: var(--haze-color-bg); border-color: var(--haze-color-primary); }
`;

const customRow = css`
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
`;

const customInput = css`
  flex: 1;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.375rem 0.5rem;
  font-size: 0.8rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:focus { outline: none; border-color: var(--haze-color-primary); }
`;

const primaryBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.375rem 0.875rem;
  font-size: 0.8rem;
  cursor: pointer;
  &:hover { opacity: 0.9; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const ghostBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.375rem 0.875rem;
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--haze-color-text);
  &:hover { background: var(--haze-color-bg-secondary); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const dangerBtn = css`
  background: none;
  border: 1px solid var(--haze-color-error, #ef4444);
  color: var(--haze-color-error, #ef4444);
  border-radius: 4px;
  padding: 0.375rem 0.875rem;
  font-size: 0.8rem;
  cursor: pointer;
  &:hover { background: var(--haze-color-error, #ef4444); color: white; }
`;

const resultBox = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.75rem;
  background: var(--haze-color-bg-secondary);
  font-size: 0.875rem;
  line-height: 1.8;
  white-space: pre-wrap;
  min-height: 80px;
  max-height: 320px;
  overflow-y: auto;
`;

const resultActions = css`
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.5rem;
`;

const statusRunning = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  font-style: italic;
`;

const errorMsg = css`
  font-size: 0.78rem;
  color: var(--haze-color-error, #ef4444);
`;

// ---- 数据 ----

/** 预设重写指令。 */
const PRESETS = [
  { label: '更紧凑', instruction: '请把这段写得更紧凑，删去冗余词句，保留核心信息与节奏。' },
  { label: '更有张力', instruction: '请重写这段，增强叙事张力与冲突感，让读者更有代入感。' },
  { label: '增加感官细节', instruction: '请重写这段，增加视觉、听觉、嗅觉等感官细节描写。' },
  { label: 'Show Don\'t Tell', instruction: '请用「展示而非讲述」的方式重写这段，用具体场景和行为代替直接陈述。' },
  { label: '增加对话', instruction: '请重写这段，适当增加人物对话，用对话推动情节与刻画人物。' },
  { label: '减少AI味', instruction: '请重写这段，去除机械化、模板化的表达，让文字更自然、更有个人风格。' },
];

/** 章节状态映射：DB 值 → 中文标签 + 徽标底色。 */
const STATUS_META: Record<string, { label: string; bg: string }> = {
  draft: { label: '草稿', bg: '#6b7280' },
  review: { label: '审阅中', bg: '#f59e0b' },
  revised: { label: '已修订', bg: '#3b82f6' },
  finalized: { label: '已定稿', bg: '#22c55e' },
};

/** 最小选中文本长度（字）。 */
const MIN_SELECTION = 50;

interface Props {
  projectId: string;
  chapterNum: number;
  /** 默认 'claude'，与 ChatPanel 保持一致 */
  agentId?: string;
  skillId?: string;
}

/** 去除 agent 输出常见的包裹（代码围栏、前言），得到纯净的重写段落。 */
function cleanRewriteResult(raw: string): string {
  let text = raw.trim();
  // 去除首尾 ``` 围栏（agent 常见的 markdown 包裹）
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  return text;
}

export default function RewritePanel({ projectId, chapterNum, agentId = 'claude', skillId = 'novel' }: Props) {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 章节内容与元数据（与 EditorPanel 共享同一缓存键）
  const { data: chapter } = useQuery({
    queryKey: ['chapter-content', projectId, chapterNum],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.chapter as { content?: string; status?: string; title?: string };
    },
  });

  const [content, setContent] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number; text: string }>({ start: 0, end: 0, text: '' });
  const [instruction, setInstruction] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // 同步章节内容到本地编辑态（仅在远程内容变化时覆盖，避免抹除本地未保存编辑）
  useEffect(() => {
    if (chapter?.content !== undefined) setContent(chapter.content);
  }, [chapter?.content]);

  const { result, isRunning, status, error, startRewrite, cancel, reset } = useRewrite();

  // 监听 textarea 选区变化
  const handleSelect = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = content.slice(start, end);
    setSelection({ start, end, text });
  }, [content]);

  const selectedLen = selection.text.trim().length;
  const canRewrite = !isRunning && selectedLen >= MIN_SELECTION && instruction.trim().length > 0;

  const handlePreset = (presetInstruction: string) => {
    setInstruction(presetInstruction);
  };

  const handleRewrite = () => {
    if (!canRewrite) return;
    reset();
    void startRewrite({
      projectId,
      chapterNum,
      selectedText: selection.text,
      instruction: instruction.trim(),
      agentId,
      skillId,
    });
  };

  /** 接受重写结果：用结果替换选区，写回章节文件。 */
  const handleAccept = async () => {
    const rewritten = cleanRewriteResult(result);
    const newContent = content.slice(0, selection.start) + rewritten + content.slice(selection.end);
    setContent(newContent);
    setSelection({ start: 0, end: 0, text: '' });
    reset();

    await saveContent(newContent);
    // 自动把状态推进到「已修订」
    if (chapter?.status !== 'revised' && chapter?.status !== 'finalized') {
      await updateStatus('revised');
    }
  };

  const handleReject = () => {
    reset();
  };

  /** 保存章节正文到磁盘（复用 PATCH 端点）。 */
  const saveContent = async (value: string) => {
    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveStatus('saved');
      await queryClient.invalidateQueries({ queryKey: ['chapter-content', projectId, chapterNum] });
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  /** 更新章节状态。 */
  const updateStatus = async (newStatus: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ['chapter-content', projectId, chapterNum] });
        await queryClient.invalidateQueries({ queryKey: ['chapters', projectId] });
      }
    } catch { /* ignore */ }
  };

  const statusValue = chapter?.status || 'draft';
  const statusMeta = STATUS_META[statusValue] || STATUS_META.draft;
  const saveLabel = saveStatus === 'saving' ? '保存中...' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : '';

  return (
    <div className={container}>
      <div className={toolbar}>
        <div className={toolbarLeft}>
          <span>第 {chapterNum} 章 · 局部重写</span>
          <span className={statusLabel} style={{ background: statusMeta.bg }}>{statusMeta.label}</span>
          {saveLabel && <span className={hint}>{saveLabel}</span>}
        </div>
        <div className={toolbarRight}>
          <span className={hint}>状态</span>
          <select
            className={statusSelect}
            value={statusValue}
            onChange={(e) => updateStatus(e.target.value)}
          >
            {Object.entries(STATUS_META).map(([value, meta]) => (
              <option key={value} value={value}>{meta.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={body}>
        <div>
          <p className={sectionTitle}>① 选中要重写的段落（至少 {MIN_SELECTION} 字）</p>
          <textarea
            ref={textareaRef}
            className={textarea}
            value={content}
            onChange={(e) => { setContent(e.target.value); setSelection({ start: 0, end: 0, text: '' }); }}
            onSelect={handleSelect}
            onMouseUp={handleSelect}
            onKeyUp={handleSelect}
            placeholder="章节内容加载中或为空..."
          />
          {selectedLen > 0 && selectedLen < MIN_SELECTION ? (
            <div className={`${hint} ${hintWarn}`}>已选 {selectedLen} 字，至少需 {MIN_SELECTION} 字</div>
          ) : (
            <div className={hint}>{selectedLen > 0 ? `已选 ${selectedLen} 字` : '在上面文本框中拖选一段文字'}</div>
          )}
        </div>

        <div>
          <p className={sectionTitle}>② 选择或输入重写指令</p>
          <div className={presetGrid}>
            {PRESETS.map((p) => (
              <button key={p.label} className={presetBtn} onClick={() => handlePreset(p.instruction)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className={customRow}>
            <input
              className={customInput}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="或输入自定义重写指令..."
            />
            {isRunning ? (
              <button className={ghostBtn} onClick={cancel}>停止</button>
            ) : (
              <button className={primaryBtn} disabled={!canRewrite} onClick={handleRewrite}>重写</button>
            )}
          </div>
        </div>

        {(result || isRunning || error) && (
          <div>
            <p className={sectionTitle}>③ 重写结果</p>
            {isRunning && <div className={statusRunning}>{status || '生成中...'}</div>}
            {error && <div className={errorMsg}>{error}</div>}
            <div className={resultBox}>{result || (isRunning ? '…' : '')}</div>
            {!isRunning && result && (
              <div className={resultActions}>
                <button className={ghostBtn} onClick={handleReject}>拒绝</button>
                <button className={primaryBtn} onClick={handleAccept}>接受并写回</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
