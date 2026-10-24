import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@linaria/core';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useAgents, useDefaultAgent } from '@/web/hooks/useAgents';
import { useProjects, useCreateProject } from '@/hooks/useProject';
import { countManuscriptChars, makePreviewText } from '@/shared/manuscript-splitter';

/**
 * 「导入手稿」向导：上传（txt/md/epub）→ 预览并调整边界（合并/拆分/改名）→ 确认。
 *
 * 预览阶段只调用 /import-manuscript/preview（不写盘）；确认后写入已有项目，
 * 或先创建新项目再写入。提交时的章节文件名由后端按连续章号生成，标题不参与路径。
 */

interface Props {
  onClose: () => void;
  /** 导入完成后回调（HomePage 用于跳转到项目页）。 */
  onImported?: (projectId: string, result: CommitResponse) => void;
  /** 从项目页打开时预选项目。 */
  initialProjectId?: string;
}

interface EditableChapter {
  id: string;
  title: string;
  heading: string;
  content: string;
  charCount: number;
  preview: string;
}

interface PreviewResponse {
  format: 'txt' | 'md' | 'epub';
  encoding: string;
  mode: string;
  warnings: string[];
  sourceChars: number;
  chapterCount: number;
  suggestedTitle?: string;
  chapters: Array<{
    number: number;
    title: string;
    heading: string;
    content: string;
    charCount: number;
    preview: string;
  }>;
}

export interface CommitResponse {
  imported: number;
  chapterNumbers: number[];
  finalized: boolean;
  statusCounts: { finalized: number; draft: number };
  overwritten: number;
  backups: number;
  removedSummaries: number;
  warnings: string[];
  snapshot: { hash: string | null; skipped: boolean; failed?: boolean };
  backfill?: {
    started: boolean;
    agentId?: string;
    runId?: string;
    conversationId?: string;
    reason?: string;
    message?: string;
  };
}

let nextChapterId = 1;
const newId = () => `mc_${nextChapterId++}`;

/** 与新建项目表单一致的类型选项。 */
const GENRE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'general', label: '通用' },
  { value: 'wuxia', label: '武侠' },
  { value: 'fantasy', label: '奇幻' },
  { value: 'scifi', label: '科幻' },
  { value: 'romance', label: '言情' },
  { value: 'mystery', label: '悬疑' },
  { value: 'horror', label: '恐怖' },
  { value: 'historical', label: '历史' },
  { value: 'reality', label: '现实' },
];

function toEditable(ch: PreviewResponse['chapters'][number]): EditableChapter {
  return {
    id: newId(),
    title: ch.title,
    heading: ch.heading,
    content: ch.content,
    charCount: ch.charCount,
    preview: ch.preview,
  };
}

function withCounts(base: Omit<EditableChapter, 'charCount' | 'preview'>): EditableChapter {
  return {
    ...base,
    charCount: countManuscriptChars(base.content),
    preview: makePreviewText(base.content),
  };
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
`;

const dialog = css`
  background: var(--haze-color-bg, #fff);
  color: var(--haze-color-text, #111);
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 10px;
  width: 920px;
  max-width: 100%;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.22);
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--haze-color-border, #e5e7eb);
  & h2 { margin: 0; font-size: 1.05rem; }
`;

const closeBtn = css`
  background: transparent;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  color: var(--haze-color-text-secondary, #6b7280);
  padding: 0.25rem;
`;

const body = css`
  padding: 1rem 1.25rem;
  overflow-y: auto;
  flex: 1;
`;

const footer = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  padding: 0.9rem 1.25rem;
  border-top: 1px solid var(--haze-color-border, #e5e7eb);
  flex-wrap: wrap;
`;

const footerRight = css`display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;`;

const primary = css`
  padding: 0.45rem 1rem;
  border-radius: 6px;
  border: 1px solid var(--haze-color-primary, #3b82f6);
  background: var(--haze-color-primary, #3b82f6);
  color: #fff;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const secondary = css`
  padding: 0.45rem 1rem;
  border-radius: 6px;
  border: 1px solid var(--haze-color-border, #e5e7eb);
  background: transparent;
  color: var(--haze-color-text, #111);
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const field = css`margin-bottom: 0.9rem;`;
const label = css`display: block; font-size: 0.8rem; font-weight: 600; margin-bottom: 0.3rem;`;
const hint = css`display: block; font-size: 0.74rem; color: var(--haze-color-text-secondary, #6b7280); margin-top: 0.25rem; line-height: 1.5;`;

const textInput = css`
  width: 100%;
  box-sizing: border-box;
  padding: 0.42rem 0.55rem;
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 6px;
  background: var(--haze-color-bg, #fff);
  color: var(--haze-color-text, #111);
  font-size: 0.85rem;
`;

const textArea = css`
  width: 100%;
  box-sizing: border-box;
  min-height: 8rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 6px;
  background: var(--haze-color-bg, #fff);
  color: var(--haze-color-text, #111);
  font-size: 0.85rem;
  font-family: inherit;
  resize: vertical;
`;

const dropZone = css`
  border: 1px dashed var(--haze-color-border, #d1d5db);
  border-radius: 8px;
  padding: 1rem;
  text-align: center;
  font-size: 0.85rem;
  color: var(--haze-color-text-secondary, #6b7280);
  cursor: pointer;
  &:hover { border-color: var(--haze-color-primary, #3b82f6); }
`;

const fileChip = css`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.6rem;
  border-radius: 999px;
  background: var(--haze-color-bg-secondary, #f3f4f6);
  font-size: 0.8rem;
`;

const row2 = css`display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;`;
const radioRow = css`display: flex; gap: 1rem; align-items: center; font-size: 0.85rem; flex-wrap: wrap;`;
const checkboxRow = css`display: flex; gap: 0.45rem; align-items: flex-start; font-size: 0.82rem; margin-bottom: 0.45rem; line-height: 1.5;`;

const warnBox = css`
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: var(--haze-color-text, #92400e);
  border-radius: 6px;
  padding: 0.55rem 0.7rem;
  font-size: 0.78rem;
  line-height: 1.55;
  margin-bottom: 0.8rem;
`;

const errorBox = css`
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: var(--haze-color-text, #b91c1c);
  border-radius: 6px;
  padding: 0.55rem 0.7rem;
  font-size: 0.8rem;
  line-height: 1.5;
  margin-bottom: 0.8rem;
`;

const chapterList = css`display: flex; flex-direction: column; gap: 0.45rem;`;

const chapterRow = css`
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
  background: var(--haze-color-bg-secondary, #fafafa);
`;

const chapterHead = css`display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;`;
const chapterNum = css`font-size: 0.75rem; color: var(--haze-color-text-secondary, #6b7280); white-space: nowrap;`;
const titleInput = css`
  flex: 1;
  min-width: 10rem;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 5px;
  background: var(--haze-color-bg, #fff);
  color: var(--haze-color-text, #111);
  font-size: 0.82rem;
`;
const meta = css`font-size: 0.72rem; color: var(--haze-color-text-secondary, #6b7280); white-space: nowrap;`;
const snippet = css`font-size: 0.76rem; color: var(--haze-color-text-secondary, #6b7280); margin-top: 0.3rem; line-height: 1.5; word-break: break-all;`;
const smallBtn = css`
  padding: 0.2rem 0.5rem;
  border-radius: 5px;
  border: 1px solid var(--haze-color-border, #e5e7eb);
  background: transparent;
  color: var(--haze-color-text, #111);
  cursor: pointer;
  font-size: 0.74rem;
  white-space: nowrap;
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;
const splitRow = css`display: flex; gap: 0.4rem; align-items: center; margin-top: 0.4rem; flex-wrap: wrap;`;
const splitInput = css`width: 7rem; padding: 0.22rem 0.4rem; border: 1px solid var(--haze-color-border, #e5e7eb); border-radius: 5px; font-size: 0.76rem; background: var(--haze-color-bg, #fff); color: var(--haze-color-text, #111);`;

const stepBadge = css`font-size: 0.75rem; color: var(--haze-color-text-secondary, #6b7280);`;

const summaryGrid = css`display: flex; gap: 1.25rem; flex-wrap: wrap; font-size: 0.8rem; margin-bottom: 0.6rem;`;

const genreSelect = css`
  width: 100%;
  padding: 0.42rem 0.55rem;
  border: 1px solid var(--haze-color-border, #e5e7eb);
  border-radius: 6px;
  background: var(--haze-color-bg, #fff);
  color: var(--haze-color-text, #111);
  font-size: 0.85rem;
`;

export default function ImportManuscriptDialog({ onClose, onImported, initialProjectId }: Props) {
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const queryClient = useQueryClient();
  const { data: agents } = useAgents();
  const defaultAgent = useDefaultAgent();
  const availableAgents = useMemo(() => (agents ?? []).filter((a) => a.available), [agents]);

  const [step, setStep] = useState<'upload' | 'preview'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [chapters, setChapters] = useState<EditableChapter[]>([]);
  const [splitAt, setSplitAt] = useState<Record<string, string>>({});
  const [splitTargetId, setSplitTargetId] = useState<string | null>(null);

  const [targetMode, setTargetMode] = useState<'existing' | 'new'>(
    initialProjectId ? 'existing' : (projects && projects.length > 0 ? 'existing' : 'new'),
  );
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? '');
  const [newTitle, setNewTitle] = useState('');
  const [newGenre, setNewGenre] = useState('general');
  const [newPath, setNewPath] = useState('');
  const [finalized, setFinalized] = useState(true);
  const [backfill, setBackfill] = useState(true);
  const [agentId, setAgentId] = useState(defaultAgent);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ projectId: string; existing: number[] } | null>(null);
  const createdProjectIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (availableAgents.length === 0) return;
    if (availableAgents.some((a) => a.id === agentId)) return;
    setAgentId(availableAgents[0].id);
  }, [availableAgents, agentId]);

  useEffect(() => {
    if (!selectedProjectId && initialProjectId) setSelectedProjectId(initialProjectId);
  }, [initialProjectId, selectedProjectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const totalChars = useMemo(() => chapters.reduce((sum, c) => sum + c.charCount, 0), [chapters]);
  const shortCount = useMemo(() => chapters.filter((c) => c.charCount < 100).length, [chapters]);

  const handlePreview = useCallback(async () => {
    setError('');
    if (!file && !pastedText.trim()) {
      setError('请选择 .txt/.md/.epub 文件，或粘贴书稿文本');
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      if (file) {
        fd.append('file', file);
      } else {
        fd.append('text', pastedText);
        fd.append('filename', 'pasted.txt');
      }
      const res = await fetch('/api/projects/import-manuscript/preview', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || `解析失败 (${res.status})`);
        return;
      }
      const parsed = data as PreviewResponse;
      if (!parsed.chapters || parsed.chapters.length === 0) {
        setError('没有切分出任何章节');
        return;
      }
      // 章节正文只保留在可编辑副本中，避免 preview 与 chapters 各存一份（大书内存翻倍）
      setPreview({ ...parsed, chapters: [] });
      setChapters(parsed.chapters.map(toEditable));
      setSplitAt({});
      setSplitTargetId(null);
      setConflict(null);
      createdProjectIdRef.current = null;
      const fileBase = file ? file.name.replace(/\.(txt|md|markdown|epub)$/i, '') : '';
      if (parsed.suggestedTitle && (!newTitle.trim() || newTitle.trim() === fileBase)) {
        setNewTitle(parsed.suggestedTitle);
      }
      if (targetMode === 'existing' && !selectedProjectId && projects && projects.length > 0) {
        setSelectedProjectId(projects[0].id);
      }
      setStep('preview');
    } catch {
      setError('解析失败，请检查文件后重试');
    } finally {
      setLoading(false);
    }
  }, [file, pastedText, newTitle, targetMode, selectedProjectId, projects]);

  const handleMergePrev = (index: number) => {
    if (index <= 0) return;
    setChapters((prev) => {
      const merged = withCounts({
        id: prev[index - 1].id,
        title: prev[index - 1].title,
        heading: prev[index - 1].heading,
        content: `${prev[index - 1].content}\n\n${prev[index].content}`.trim(),
      });
      return [...prev.slice(0, index - 1), merged, ...prev.slice(index + 1)];
    });
    setConflict(null);
  };

  const handleSplit = (chapter: EditableChapter) => {
    const raw = splitAt[chapter.id] ?? '';
    const at = parseInt(raw, 10);
    if (!Number.isFinite(at) || at < 1 || at >= chapter.content.length) {
      toast.error(`请输入 1–${Math.max(1, chapter.content.length - 1)} 之间的拆分位置`);
      return;
    }
    // 拆分点向最近的段落边界靠拢（最多向后 200 字），避免把句子切断
    let cut = chapter.content.indexOf('\n', at);
    if (cut === -1 || cut > at + 200) cut = at;
    // 不切断代理对（emoji 等）
    if (cut > 0 && /[\uD800-\uDBFF]/.test(chapter.content[cut - 1])) cut -= 1;
    const head = chapter.content.slice(0, cut).trim();
    const tail = chapter.content.slice(cut).trim();
    if (!head || !tail) {
      toast.error('拆分后存在空章节，请调整拆分位置');
      return;
    }
    setChapters((prev) => {
      const index = prev.findIndex((c) => c.id === chapter.id);
      if (index === -1) return prev;
      const first = withCounts({
        id: prev[index].id,
        title: prev[index].title,
        heading: prev[index].heading,
        content: head,
      });
      const second = withCounts({ id: newId(), title: '', heading: '', content: tail });
      return [...prev.slice(0, index), first, second, ...prev.slice(index + 1)];
    });
    setSplitTargetId(null);
    setSplitAt((prev) => ({ ...prev, [chapter.id]: '' }));
    setConflict(null);
  };

  const resolveProjectId = async (): Promise<string | null> => {
    if (targetMode === 'existing') {
      if (!selectedProjectId) {
        setError('请选择要导入的项目');
        return null;
      }
      return selectedProjectId;
    }
    if (createdProjectIdRef.current) return createdProjectIdRef.current;
    const title = newTitle.trim() || preview?.suggestedTitle || '未命名项目';
    const created = await createProject.mutateAsync({
      title,
      genre: newGenre,
      ...(newPath.trim() ? { path: newPath.trim() } : {}),
      chapterCount: Math.max(1, chapters.length),
      targetWords: Math.max(1000, totalChars),
    });
    createdProjectIdRef.current = created.project.id;
    if (created.warning) toast.warning(created.warning);
    return created.project.id;
  };

  const handleCommit = async (overwrite: boolean) => {
    setError('');
    if (chapters.length === 0) {
      setError('没有可导入的章节');
      return;
    }
    setBusy(true);
    try {
      const projectId = createdProjectIdRef.current
        ?? (conflict?.projectId ?? await resolveProjectId());
      if (!projectId) return;

      const res = await fetch(`/api/projects/${projectId}/import-manuscript/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapters: chapters.map((c) => ({ title: c.title, content: c.content })),
          finalized,
          overwrite,
          backfill: backfill && availableAgents.length > 0,
          agentId: backfill ? agentId : undefined,
        }),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        if (data.error === 'chapters-exist') {
          setConflict({
            projectId,
            existing: Array.isArray(data.existingChapters) ? data.existingChapters as number[] : [],
          });
          return;
        }
        setError((data.message as string) || (data.error as string) || `导入失败 (${res.status})`);
        return;
      }

      const result = data as unknown as CommitResponse;
      const warnNote = result.warnings?.length ? `；${result.warnings[0]}` : '';
      toast.success(`已导入 ${result.imported} 章${finalized ? '（已定稿）' : '（草稿）'}${warnNote}`);
      if (result.backfill?.started) {
        toast.message('已开始后台补全章节摘要与角色状态');
        // 与 ChatPanel 的会话持久化约定对齐：进入项目页后直接连着补全 run 的会话，
        // 用户能看到流式进度，而不是只看到项目被锁。
        if (result.backfill.conversationId) {
          try {
            localStorage.setItem(`open-novel:active-conversation:${projectId}`, result.backfill.conversationId);
          } catch { /* 存储不可用则退回默认会话 */ }
          // 让项目页的会话下拉尽快包含新建的补全会话
          void queryClient.invalidateQueries({ queryKey: ['conversations', projectId] });
        }
      } else if (backfill && availableAgents.length > 0 && result.backfill && !result.backfill.started) {
        toast.warning(result.backfill.message || '自动补全未能启动，可在项目中手动运行 /enrich');
      }
      onImported?.(projectId, result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const canCommit = chapters.length > 0 && (targetMode === 'new' || selectedProjectId !== '');
  const stepLabel = step === 'upload' ? '第 1 步 / 2 · 选择书稿' : '第 2 步 / 2 · 核对章节边界';

  return (
    <div className={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={dialog} role="dialog" aria-modal="true" aria-label="导入手稿">
        <div className={header}>
          <div>
            <h2>导入手稿</h2>
            <span className={stepBadge}>{stepLabel}</span>
          </div>
          <button className={closeBtn} onClick={onClose} disabled={busy} title="关闭" aria-label="关闭">×</button>
        </div>

        <div className={body}>
          {error && <div className={errorBox}>{error}</div>}

          {step === 'upload' && (
            <>
              <div className={field}>
                <label className={label}>书稿文件</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.markdown,.epub,text/plain,text/markdown,application/epub+zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const chosen = e.target.files?.[0] ?? null;
                    setFile(chosen);
                    setError('');
                    if (chosen && !newTitle.trim()) {
                      setNewTitle(chosen.name.replace(/\.(txt|md|markdown|epub)$/i, ''));
                    }
                  }}
                />
                <div className={dropZone} onClick={() => fileInputRef.current?.click()}>
                  {file ? (
                    <span className={fileChip}>
                      📄 {file.name}（{(file.size / 1024).toFixed(0)} KB）
                      <button
                        className={smallBtn}
                        onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      >移除</button>
                    </span>
                  ) : (
                    <>点击选择 .txt / .md / .epub 文件（最大 25MB）</>
                  )}
                </div>
                <span className={hint}>
                  支持中文「第N章/回/节」、英文 Chapter N、Markdown #/## 标题；识别不到标题时按段落自动切分。
                  GBK 编码的 txt 会自动按 GB18030 读取。
                </span>
              </div>

              <div className={field}>
                <button className={secondary} onClick={() => setShowPaste((v) => !v)}>
                  {showPaste ? '收起粘贴框' : '或直接粘贴书稿文本'}
                </button>
                {showPaste && (
                  <textarea
                    className={textArea}
                    style={{ marginTop: '0.5rem' }}
                    placeholder="在此粘贴整部书稿…"
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                  />
                )}
              </div>

              <div className={field}>
                <label className={label}>导入到</label>
                <div className={radioRow}>
                  <label>
                    <input type="radio" checked={targetMode === 'existing'} onChange={() => setTargetMode('existing')} />
                    {' '}已有项目
                  </label>
                  <label>
                    <input type="radio" checked={targetMode === 'new'} onChange={() => setTargetMode('new')} />
                    {' '}新建项目
                  </label>
                </div>
                {targetMode === 'existing' ? (
                  <select
                    className={genreSelect}
                    style={{ marginTop: '0.5rem' }}
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    <option value="">选择项目…</option>
                    {(projects ?? []).map((p) => (
                      <option key={p.id} value={p.id}>{p.title}（{p.chapterCount} 章）</option>
                    ))}
                  </select>
                ) : (
                  <div style={{ marginTop: '0.5rem' }}>
                    <div className={row2}>
                      <div>
                        <label className={label}>小说标题</label>
                        <input
                          className={textInput}
                          placeholder="例如：山河入梦"
                          maxLength={200}
                          value={newTitle}
                          onChange={(e) => setNewTitle(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className={label}>类型</label>
                        <select className={genreSelect} value={newGenre} onChange={(e) => setNewGenre(e.target.value)}>
                          {GENRE_OPTIONS.map((g) => (
                            <option key={g.value} value={g.value}>{g.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <label className={label} style={{ marginTop: '0.6rem' }}>保存位置（可选）</label>
                    <input
                      className={textInput}
                      placeholder="默认 ~/novels/＜标题拼音＞"
                      value={newPath}
                      onChange={(e) => setNewPath(e.target.value)}
                    />
                  </div>
                )}
                <span className={hint}>导入会覆盖同名章号的文件（提交前会再次确认）；标题只写入正文，不作为文件名。</span>
              </div>
            </>
          )}

          {step === 'preview' && preview && (
            <>
              <div className={summaryGrid}>
                <span>格式：{preview.format.toUpperCase()}</span>
                <span>编码：{preview.encoding.toUpperCase()}</span>
                <span>切分方式：{preview.mode === 'fixed' ? '按字数自动切分' : preview.mode === 'markdown' ? 'Markdown 标题' : preview.mode === 'numeric' ? '数字标题' : '章节标题'}</span>
                <span>共 {chapters.length} 章 / 约 {totalChars.toLocaleString()} 字</span>
              </div>

              {preview.warnings.length > 0 && (
                <div className={warnBox}>
                  {preview.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}

              <div className={field}>
                <label className={label}>章节边界（可合并、拆分、改名）</label>
                <span className={hint}>
                  章号按导入顺序连续编号；标题里残留的「第N章」前缀会被忽略，标题只写入正文首行。
                </span>
                <div className={chapterList}>
                  {chapters.map((chapter, index) => (
                    <div key={chapter.id} className={chapterRow}>
                      <div className={chapterHead}>
                        <span className={chapterNum}>第 {index + 1} 章</span>
                        <input
                          className={titleInput}
                          placeholder={chapter.heading || '（无标题，可输入）'}
                          value={chapter.title}
                          onChange={(e) => {
                            const title = e.target.value;
                            setChapters((prev) => prev.map((c) => (c.id === chapter.id ? { ...c, title } : c)));
                          }}
                        />
                        <span className={meta}>{chapter.charCount.toLocaleString()} 字</span>
                        <button
                          className={smallBtn}
                          disabled={index === 0}
                          onClick={() => handleMergePrev(index)}
                          title="与上一章合并"
                        >合并到上一章</button>
                        <button
                          className={smallBtn}
                          onClick={() => {
                            if (splitTargetId === chapter.id) {
                              setSplitTargetId(null);
                              return;
                            }
                            setSplitTargetId(chapter.id);
                            setSplitAt((prev) => ({
                              ...prev,
                              [chapter.id]: String(Math.max(1, Math.floor(chapter.content.length / 2))),
                            }));
                          }}
                          title="在指定字符位置拆分本章"
                        >拆分</button>
                      </div>
                      <div className={snippet}>{chapter.preview || '（正文为空）'}</div>
                      {splitTargetId === chapter.id && (
                        <div className={splitRow}>
                          <span className={meta}>拆分位置（字符）：</span>
                          <input
                            className={splitInput}
                            type="number"
                            min={1}
                            max={Math.max(1, chapter.content.length - 1)}
                            placeholder={String(Math.floor(chapter.content.length / 2))}
                            value={splitAt[chapter.id] ?? ''}
                            onChange={(e) => setSplitAt((prev) => ({ ...prev, [chapter.id]: e.target.value }))}
                          />
                          <span className={meta}>共 {chapter.content.length} 字符</span>
                          <button
                            className={smallBtn}
                            onClick={() => handleSplit(chapter)}
                          >
                            确认拆分
                          </button>
                          <button className={smallBtn} onClick={() => setSplitTargetId(null)}>取消</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className={field}>
                <label className={checkboxRow}>
                  <input type="checkbox" checked={finalized} onChange={(e) => setFinalized(e.target.checked)} />
                  <span>导入的章节标记为「已定稿」{shortCount > 0 ? `（其中 ${shortCount} 章不足 100 字，将按草稿保存）` : ''}</span>
                </label>
                <label className={checkboxRow}>
                  <input
                    type="checkbox"
                    checked={backfill && availableAgents.length > 0}
                    disabled={availableAgents.length === 0}
                    onChange={(e) => setBackfill(e.target.checked)}
                  />
                  <span>
                    导入后用 AI 补全章节摘要与角色状态（只增不覆盖，需要可用 CLI agent）
                    {availableAgents.length === 0 ? '——当前没有可用 agent' : ''}
                  </span>
                </label>
                {backfill && availableAgents.length > 0 && (
                  <div style={{ marginLeft: '1.4rem' }}>
                    <select className={genreSelect} value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ maxWidth: '16rem' }}>
                      {availableAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {conflict && (
                <div className={warnBox}>
                  项目已有第 {conflict.existing.slice(0, 12).join('、')}{conflict.existing.length > 12 ? '…' : ''} 章与本次导入重叠。
                  原文件会备份为 .bak，旧章节摘要会删除并重新生成。
                </div>
              )}

              <div className={field}>
                <label className={label}>导入到</label>
                <span style={{ fontSize: '0.82rem' }}>
                  {createdProjectIdRef.current
                    ? `新建项目（已创建）「${newTitle.trim() || preview.suggestedTitle || '未命名项目'}」`
                    : targetMode === 'existing'
                      ? ((projects ?? []).find((p) => p.id === selectedProjectId)?.title ?? '（未选择项目）')
                      : `新建项目「${newTitle.trim() || preview.suggestedTitle || '未命名项目'}」`}
                </span>
              </div>
            </>
          )}
        </div>

        <div className={footer}>
          <span className={meta}>{step === 'preview' ? `${chapters.length} 章待导入` : file ? '已选择文件' : '等待选择书稿'}</span>
          <div className={footerRight}>
            {step === 'preview' && (
              <button className={secondary} disabled={busy} onClick={() => { setStep('upload'); setConflict(null); }}>
                上一步
              </button>
            )}
            <button className={secondary} disabled={busy} onClick={onClose}>取消</button>
            {step === 'upload' ? (
              <button className={primary} disabled={loading} onClick={handlePreview}>
                {loading ? '解析中…' : '解析并预览'}
              </button>
            ) : conflict ? (
              <button className={primary} disabled={busy || !canCommit} onClick={() => void handleCommit(true)}>
                {busy ? '导入中…' : '覆盖并导入'}
              </button>
            ) : (
              <button className={primary} disabled={busy || !canCommit} onClick={() => void handleCommit(false)}>
                {busy ? '导入中…' : `确认导入 ${chapters.length} 章`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
