import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { css } from '@linaria/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Sidebar from '@/web/components/Sidebar';
import WorkflowProgress from '@/web/components/WorkflowProgress';
import ChatPanel from '@/web/components/ChatPanel';
import EditorPanel from '@/web/components/EditorPanel';
import RewritePanel from '@/web/components/RewritePanel';
import QualityCheckPanel from '@/web/components/QualityCheckPanel';
import FilePreview from '@/web/components/FilePreview';
import ReviewPanel from '@/web/components/ReviewPanel';
import SnapshotList from '@/web/components/SnapshotList';
import { useFilePreview } from '@/web/hooks/useFilePreview';
import { useReview } from '@/web/hooks/useReview';
import { useAgentSelection } from '@/web/hooks/useAgents';
import { useChatPanelWidth } from '@/web/hooks/useChatPanelWidth';
import { useDocSourceFile } from '@/web/hooks/useDocSourceFile';
import { STAGES } from '@/shared/stages';

// 视图组件懒加载 —— 只在切换到对应视图时下载
const DashboardView = lazy(() => import('@/web/components/views/DashboardView'));
const ConceptView = lazy(() => import('@/web/components/views/ConceptView'));
const WorldView = lazy(() => import('@/web/components/views/WorldView'));
const CharacterView = lazy(() => import('@/web/components/views/CharacterView'));
const OutlineView = lazy(() => import('@/web/components/views/OutlineView'));
const SceneView = lazy(() => import('@/web/components/views/SceneView'));
const ForeshadowView = lazy(() => import('@/web/components/views/ForeshadowView'));
const StoryArcView = lazy(() => import('@/web/components/views/StoryArcView'));
const CharacterGraphView = lazy(() => import('@/web/components/views/CharacterGraphView'));
const WuxiaView = lazy(() => import('@/web/components/views/WuxiaView'));
const WritingView = lazy(() => import('@/web/components/views/WritingView'));

/** Sidebar chapters 回退常量——避免每次渲染新建数组导致 memo 失效。 */
const EMPTY_CHAPTERS: Array<{ number: number; title: string | null }> = [];

const layout = css`
  display: flex;
  height: 100%;
  @media (max-width: 768px) {
    flex-direction: column;
  }
`;

const main = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
`;

const topBar = css`
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  @media (max-width: 768px) {
    padding: 0.5rem;
    gap: 0.5rem;
  }
`;

const backLink = css`
  font-size: 0.875rem;
  color: var(--haze-color-text-secondary);
  &:hover { color: var(--haze-color-text); }
`;

const content = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
`;

const chatPanel = css`
  width: var(--chat-width, 400px);
  border-left: 1px solid var(--haze-color-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  @media (max-width: 768px) {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--haze-color-border);
    height: 50vh;
  }
`;

const resizeHandle = css`
  flex: 0 0 6px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 5;
  user-select: none;
  transition: background-color 0.15s;
  &:hover,
  &:active {
    background-color: var(--haze-color-border);
  }
  &::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 2px;
    height: 28px;
    border-radius: 2px;
    background: var(--haze-color-border);
    opacity: 0.5;
    transition: opacity 0.15s;
  }
  &:hover::after,
  &:active::after {
    opacity: 1;
  }
  @media (max-width: 768px) {
    display: none;
  }
`;

const previewPanel = css`
  width: 350px;
  border-left: 1px solid var(--haze-color-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const previewToggle = css`
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
  z-index: 10;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

const reviewBadge = css`
  margin-left: 0.25rem;
  background: var(--haze-color-primary);
  color: white;
  border-radius: 8px;
  padding: 0 0.4rem;
  font-size: 0.7rem;
`;

const rewriteDetails = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  overflow: hidden;
  &[open] > summary { border-bottom: 1px solid var(--haze-color-border); }
`;

const rewriteSummary = css`
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--haze-color-text-secondary);
  user-select: none;
  &:hover { color: var(--haze-color-text); }
`;

const undoOverlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
`;

const undoPanel = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  width: 480px;
  max-width: calc(100vw - 2rem);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const undoHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.9rem;
`;

const undoClose = css`
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--haze-color-text-secondary);
  &:hover { color: var(--haze-color-text); }
`;

const undoBody = css`
  overflow-y: auto;
  padding: 0.75rem 1rem;
`;

/** 全屏状态占位（加载中 / 加载失败 / 项目不存在）。 */
const stateWrap = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 2rem;
  text-align: center;
  gap: 0.75rem;
`;

const stateTitle = css`
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
`;

const stateMsg = css`
  font-size: 0.875rem;
  color: var(--haze-color-text-secondary);
  max-width: 420px;
  margin: 0;
`;

const stateActions = css`
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
`;

const retryBtn = css`
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.4rem 1rem;
  cursor: pointer;
  font-size: 0.875rem;
  &:hover { background: var(--haze-color-bg); }
`;

/* 编辑器与重写面板外层容器 */
const editorWrap = css`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
`;

const editorContent = css`
  flex: 1;
  min-height: 0;
  overflow: auto;
`;

const toolbarActions = css`
  display: flex;
  gap: 0.375rem;
  margin-left: auto;
`;

function ViewRouter({ activeView, projectId, onViewChange, agentId, skillId }: { activeView: string; projectId: string; onViewChange: (view: string) => void; agentId: string; skillId: string }) {
  if (activeView === 'dashboard') return <DashboardView projectId={projectId} />;
  if (activeView === 'concept') return <ConceptView projectId={projectId} />;
  if (activeView === 'world') return <WorldView projectId={projectId} />;
  if (activeView === 'characters') return <CharacterView projectId={projectId} />;
  if (activeView === 'outline') return <OutlineView projectId={projectId} />;
  if (activeView === 'scenes') return <SceneView projectId={projectId} />;
  if (activeView === 'foreshadow') return <ForeshadowView projectId={projectId} />;
  if (activeView === 'story-arc') return <StoryArcView projectId={projectId} />;
  if (activeView === 'character-graph') return <CharacterGraphView projectId={projectId} />;
  if (activeView === 'wuxia') return <WuxiaView projectId={projectId} />;
  if (activeView === 'sample') return <WritingView projectId={projectId} onViewChange={onViewChange} variant="sample" />;
  if (activeView === 'writing') return <WritingView projectId={projectId} onViewChange={onViewChange} />;
  // drafting/revision/polish 是写作子模式（/draft /revision /polish 命令切换），
  // 没有独立视图——映射到写作视图，避免落入「未知视图」兜底。
  if (activeView === 'drafting' || activeView === 'revision' || activeView === 'polish') {
    return <WritingView projectId={projectId} onViewChange={onViewChange} />;
  }
  if (activeView.startsWith('chapter-')) {
    const num = parseInt(activeView.replace('chapter-', ''), 10);
    return (
      <div className={editorWrap}>
        <div className={editorContent}>
          <EditorPanel projectId={projectId} chapterNum={num} agentId={agentId} skillId={skillId} />
        </div>
        <details className={rewriteDetails}>
          <summary className={rewriteSummary}>✍️ 局部重写工作台</summary>
          <RewritePanel projectId={projectId} chapterNum={num} agentId={agentId} skillId={skillId} />
        </details>
        <details className={rewriteDetails}>
          <summary className={rewriteSummary}>🔍 质量检查面板</summary>
          <QualityCheckPanel projectId={projectId} chapterNum={num} />
        </details>
      </div>
    );
  }
  return <div>未知视图: {activeView}</div>;
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = searchParams.get('view') || 'dashboard';
  const setActiveView = useCallback((view: string) => {
    // dashboard 是默认视图，不写入 URL 保持地址干净
    setSearchParams(view === 'dashboard' ? {} : { view }, { replace: true });
  }, [setSearchParams]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const { readFile, loading: previewLoading } = useFilePreview(id!);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const review = useReview(id!);

  const queryClient = useQueryClient();
  const { data: project, isLoading, error, refetch: refetchProject } = useQuery({
    queryKey: ['project', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}`);
      // 检查响应状态：404（项目不存在）等需进入 error 态，否则下面 data.project 为 undefined，
      // 会被误判成「加载中」无限转圈（旧 bug：把 Not Found 静默成 loading）。
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // 附带 status，供 retry 判断 4xx 不重试。
        throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status });
      }
      const data = await res.json();
      return data.project;
    },
    // 4xx（项目不存在/权限）不重试；网络/5xx 最多重试 2 次。
    retry: (count, err) => {
      const status = (err as Error & { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) return false;
      return count < 2;
    },
  });

  // Preload mermaid core (~500KB) in idle time so the first diagram renders
  // without a visible delay. Multiple project views use mermaid diagrams
  // (story-arc, character-graph, foreshadow, timeline, etc.).
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const ric = w.requestIdleCallback;
    const handle = ric
      ? ric(() => { void import('mermaid'); }, { timeout: 4000 })
      : window.setTimeout(() => { void import('mermaid'); }, 2000);
    return () => {
      if (w.cancelIdleCallback) w.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  // 使用 ref 持有 previewFile 避免 SSE 因视图切换重建
  const previewFileRef = useRef(previewFile);
  previewFileRef.current = previewFile;

  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;

  // Subscribe to project updates and file changes via SSE
  // 只依赖 id 而非 previewFile/readFile，避免视图切换时断线重连
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/projects/${id}/events`);

    es.addEventListener('project-updated', () => {
      refetchProject();
      queryClient.invalidateQueries({ queryKey: ['project', id] });
    });

    es.addEventListener('file-changed', (e) => {
      try {
        const data = JSON.parse(e.data);
        const filePath = data.path as string;

        // Invalidate view queries based on changed file
        if (filePath.startsWith('concept/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-document', id, 'concept'] });
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'concept'] });
        } else if (filePath.startsWith('world/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-document', id, 'world'] });
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'world'] });
        } else if (filePath?.startsWith('characters/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'characters'] });
        } else if (filePath.startsWith('outline/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-document', id, 'outline'] });
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'outline'] });
        } else if (filePath === 'outline-brief.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'outline-brief'] });
        } else if (filePath === 'scenes.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'scenes'] });
        } else if (filePath === 'foreshadow.json') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'foreshadow'] });
        } else if (filePath?.startsWith('chapters/')) {
          // 章节文件变更：刷新写作视图章节列表/字数（之前此分支缺失导致列表滞后）
          queryClient.invalidateQueries({ queryKey: ['chapters', id] });
        } else if (filePath === 'state.json' || filePath === 'state-intent.json' || filePath === 'progress.md' || filePath === 'character-states.md') {
          // 状态/进度文件变更：刷新总览（卫生警示、伏笔债务摘要、进度）
          queryClient.invalidateQueries({ queryKey: ['state-hygiene', id] });
          queryClient.invalidateQueries({ queryKey: ['foreshadow-stats', id] });
        } else if (filePath === 'config.json') {
          // Config changed - refetch project for stage updates
          refetchProject();
          queryClient.invalidateQueries({ queryKey: ['project', id] });
        }

        // Refresh preview if showing this file（通过 ref 避免依赖 previewFile）
        const currentPreviewFile = previewFileRef.current;
        const currentReadFile = readFileRef.current;
        if (currentPreviewFile && filePath === currentPreviewFile) {
          currentReadFile(currentPreviewFile).then((content) => {
            if (content) setPreviewContent(content);
          });
        }
      } catch { /* ignore */ }
    });

    return () => {
      es.close();
    };
  }, [id, refetchProject, queryClient]);

  // Auto-switch view when stage changes (only if user hasn't manually navigated)
  const [hasManualNav, setHasManualNav] = useState(false);
  useEffect(() => {
    if (project?.currentStage && activeView === 'dashboard' && !hasManualNav) {
      // Don't auto-switch for the initial "concept" stage on new projects
      if (project.currentStage !== 'concept') {
        setActiveView(project.currentStage);
      }
    }
  }, [project?.currentStage]);

  const { data: chapters } = useQuery({
    queryKey: ['chapters', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });

  // 用户可选 agent，持久化到 localStorage；setAgentId 传给 ChatPanel
  const [activeAgentId, setActiveAgentId] = useAgentSelection();

  // 右侧会话面板宽度（可拖拽，持久化）
  const { width: chatWidth, isResizing, resizeHandleProps } = useChatPanelWidth();

  // Load preview content when file changes
  useEffect(() => {
    if (!previewFile) {
      setPreviewContent(null);
      return;
    }
    let cancelled = false;
    readFile(previewFile).then((content) => {
      if (!cancelled) setPreviewContent(content);
    });
    return () => { cancelled = true; };
  }, [previewFile, readFile]);

  // Map view to file path for preview
  // doc 类型用后端返回的 sourceFile（旧格式回退到单文件）
  const docSourceFile = useDocSourceFile(id!);
  const viewToFile = useMemo<Record<string, string>>(() => ({
    concept: docSourceFile.concept ?? 'concept/index.md',
    world: docSourceFile.world ?? 'world/index.md',
    characters: 'characters/profiles.md',
    outline: docSourceFile.outline ?? 'outline/index.md',
    scenes: 'scenes.md',
    foreshadow: 'foreshadow.json',
    wuxia: docSourceFile.world ?? 'world/index.md',
  }), [docSourceFile.concept, docSourceFile.world, docSourceFile.outline]);

  // 直接通过 URL 进入某个视图时（handleViewChange 未被调用），
  // 按 viewToFile 同步默认预览文件。
  useEffect(() => {
    const defaultFile = viewToFile[activeView];
    if (defaultFile && defaultFile !== previewFile) {
      setPreviewFile(defaultFile);
    }
  }, [activeView]);

  const handleViewChange = useCallback((view: string) => {
    setActiveView(view);
    setHasManualNav(true);
    if (viewToFile[view]) {
      setPreviewFile(viewToFile[view]);
      setShowPreview(true);
    }
  }, [viewToFile]);

  /** 阶段切换（进度条 / ChatPanel 命令）：切视图之外还要 PATCH currentStage 落库，
   * 否则「视图」与「阶段」脱钩——发消息仍走旧阶段的提示词（旧缺陷）。
   * 写作子模式（drafting/revision/polish）不是主阶段，仅切视图不落库。 */
  const handleStageChange = useCallback(async (stageId: string) => {
    handleViewChange(stageId);
    const isMainStage = STAGES.some((s) => s.id === stageId);
    if (!isMainStage || stageId === project?.currentStage) return;
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentStage: stageId }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['project', id] });
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error || '阶段切换失败');
      }
    } catch {
      toast.error('阶段切换失败');
    }
  }, [handleViewChange, id, project?.currentStage, queryClient]);

  const handleExport = (format: 'markdown' | 'text') => {
    window.open(`/api/projects/${id}/export/${format}`, '_blank');
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message || '同步完成');
      } else {
        toast.error(data.error || '同步失败');
      }
    } catch {
      toast.error('同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveSnapshot = async () => {
    const name = window.prompt('请输入版本名称（如：第3章初稿）');
    if (!name || !name.trim()) return;
    setSnapshotSaving(true);
    try {
      const res = await fetch(`/api/runs/projects/${id}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`已保存版本「${name.trim()}」`);
      } else {
        toast.error(data.error || '保存版本失败');
      }
    } catch {
      toast.error('保存版本失败');
    } finally {
      setSnapshotSaving(false);
    }
  };

  const handleUndo = () => {
    // 打开快照列表对话框：用户选择要恢复的快照（替代旧的「恢复最新快照」单键）
    setShowSnapshots(true);
  };


  if (isLoading) return <div className={stateWrap}>加载中...</div>;
  if (error || !project) {
    // 区分「项目不存在」(404) 与「加载失败」(网络/5xx)，给出不同文案与动作。
    const status = (error as Error & { status?: number })?.status;
    const isNotFound = status === 404 || /not found/i.test(error?.message || '');
    return (
      <div className={stateWrap}>
        <h2 className={stateTitle}>{isNotFound ? '项目不存在' : '加载失败'}</h2>
        <p className={stateMsg}>
          {isNotFound
            ? '该项目可能已被删除，或链接已失效。请从首页选择一个现有项目。'
            : (error?.message || '无法连接服务器，请稍后重试。')}
        </p>
        <div className={stateActions}>
          <Link to="/" className={backLink}>← 返回首页</Link>
          {!isNotFound && (
            <button className={retryBtn} onClick={() => refetchProject()}>重试</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={layout}>
      <Sidebar activeView={activeView} onViewChange={handleViewChange} chapters={chapters ?? EMPTY_CHAPTERS} skillId={project.skillId} />
      <div className={main}>
        <div className={topBar}>
          <Link to="/" className={backLink}>← 首页</Link>
          <h2>{project.title}</h2>
          <WorkflowProgress currentStage={project.currentStage} onStageClick={handleStageChange} />
          <div className={toolbarActions}>
            <button className={previewToggle} onClick={() => setShowReview(true)} title="审阅并合并 draft 到 main">
              审阅{review.pendingCount > 0 && <span className={reviewBadge}>{review.pendingCount}</span>}
            </button>
            <button className={previewToggle} onClick={() => handleExport('markdown')} title="导出 Markdown">MD</button>
            <button className={previewToggle} onClick={() => handleExport('text')} title="导出 TXT">TXT</button>
            <button className={previewToggle} onClick={handleUndo} title="撤销上次更改">撤销</button>
            <button className={previewToggle} onClick={handleSaveSnapshot} disabled={snapshotSaving} title="保存当前状态为版本标记">
              {snapshotSaving ? '保存中...' : '存版本'}
            </button>
            <button className={previewToggle} onClick={handleSync} disabled={syncing} title="同步到远程仓库">
              {syncing ? '同步中...' : '同步'}
            </button>
            <button className={previewToggle} onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? '隐藏预览' : '显示预览'}
            </button>
          </div>
        </div>
        <div className={content}>
          <Suspense fallback={<div className={stateWrap}>加载视图...</div>}>
            <ViewRouter activeView={activeView} projectId={id!} onViewChange={handleViewChange} agentId={activeAgentId} skillId={project.skillId} />
          </Suspense>
        </div>
      </div>
      {showPreview && (
        <div className={previewPanel}>
          <FilePreview
            projectId={id!}
            filePath={previewFile}
            content={previewContent}
            loading={previewLoading}
          />
        </div>
      )}
      <div
        className={resizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整会话面板宽度"
        tabIndex={0}
        {...resizeHandleProps}
      />
      <div
        className={chatPanel}
        style={{ ['--chat-width' as string]: `${chatWidth}px` }}
        data-testid="chat-panel"
        data-resizing={isResizing ? 'true' : undefined}
      >
        <ChatPanel key={id} projectId={id!} agentId={activeAgentId} onAgentChange={setActiveAgentId} skillId={project.skillId} stage={project.currentStage} onStageChange={handleStageChange} />
      </div>
      {showReview && (
        <ReviewPanel
          review={review.review}
          onMerge={async () => {
            try {
              await review.merge();
              toast.success('已合并到 main');
            } catch {
              toast.error('合并失败');
            }
            setShowReview(false);
          }}
          onDiscard={async () => {
            try {
              await review.discard();
              toast.success('已丢弃未审阅改动');
            } catch {
              toast.error('丢弃失败');
            }
            setShowReview(false);
          }}
          merging={review.merging}
          discarding={review.discarding}
          onClose={() => setShowReview(false)}
        />
      )}
      {showSnapshots && (
        <div className={undoOverlay} onClick={() => setShowSnapshots(false)}>
          <div className={undoPanel} onClick={(e) => e.stopPropagation()}>
            <div className={undoHeader}>
              <strong>选择要恢复的快照</strong>
              <button className={undoClose} onClick={() => setShowSnapshots(false)} title="关闭">✕</button>
            </div>
            <div className={undoBody}>
              <SnapshotList projectId={id!} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
