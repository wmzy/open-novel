import { useState, useEffect, useCallback } from 'react';
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
import { useFilePreview } from '@/web/hooks/useFilePreview';
import DashboardView from '@/web/components/views/DashboardView';
import ConceptView from '@/web/components/views/ConceptView';
import WorldView from '@/web/components/views/WorldView';
import CharacterView from '@/web/components/views/CharacterView';
import OutlineView from '@/web/components/views/OutlineView';
import SceneView from '@/web/components/views/SceneView';
import ForeshadowView from '@/web/components/views/ForeshadowView';
import StoryArcView from '@/web/components/views/StoryArcView';
import CharacterGraphView from '@/web/components/views/CharacterGraphView';
import WuxiaView from '@/web/components/views/WuxiaView';
import WritingView from '@/web/components/views/WritingView';
import { useAgentSelection } from '@/web/hooks/useAgents';
import { useChatPanelWidth } from '@/web/hooks/useChatPanelWidth';

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
  if (activeView === 'writing') return <WritingView projectId={projectId} onViewChange={onViewChange} />;
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

  // Subscribe to project updates and file changes via SSE
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
        if (filePath === 'concept.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'concept'] });
        } else if (filePath === 'world-building.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'world'] });
        } else if (filePath?.startsWith('characters/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'characters'] });
        } else if (filePath === 'outline.md' || filePath === 'outline-detailed.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'outline'] });
        } else if (filePath === 'scenes.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'scenes'] });
        } else if (filePath === 'foreshadow.json') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'foreshadow'] });
        } else if (filePath === 'config.json') {
          // Config changed - refetch project for stage updates
          refetchProject();
          queryClient.invalidateQueries({ queryKey: ['project', id] });
        }

        // Refresh preview if showing this file
        if (previewFile && filePath === previewFile) {
          readFile(previewFile).then((content) => {
            if (content) setPreviewContent(content);
          });
        }
      } catch { /* ignore */ }
    });

    return () => es.close();
  }, [id, refetchProject, previewFile, readFile, queryClient]);

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
  const viewToFile: Record<string, string> = {
    concept: 'concept.md',
    world: 'world-building.md',
    characters: 'characters/profiles.md',
    outline: 'outline-detailed.md',
    scenes: 'scenes.md',
    foreshadow: 'foreshadow.json',
  };

  const handleViewChange = (view: string) => {
    setActiveView(view);
    setHasManualNav(true);
    if (viewToFile[view]) {
      setPreviewFile(viewToFile[view]);
      setShowPreview(true);
    }
  };

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

  const handleUndo = async () => {
    try {
      const res = await fetch(`/api/runs/projects/${id}/snapshots`);
      const data = await res.json();
      const snapshots = data.snapshots || [];
      if (snapshots.length === 0) {
        toast.info('没有可用的快照');
        return;
      }
      const latest = snapshots[0];

      toast(`恢复到快照 ${latest.hash.slice(0, 8)}？`, {
        description: latest.message,
        action: {
          label: '确认恢复',
          onClick: async () => {
            const rollbackRes = await fetch(`/api/runs/projects/${id}/rollback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ commitHash: latest.hash }),
            });
            if (rollbackRes.ok) {
              toast.success('撤销成功，正在刷新...');
              window.location.reload();
            } else {
              toast.error('撤销失败');
            }
          },
        },
      });
    } catch {
      toast.error('撤销失败');
    }
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
      <Sidebar activeView={activeView} onViewChange={handleViewChange} chapters={chapters || []} />
      <div className={main}>
        <div className={topBar}>
          <Link to="/" className={backLink}>← 首页</Link>
          <h2>{project.title}</h2>
          <WorkflowProgress currentStage={project.currentStage} onStageClick={handleViewChange} />
          <div className={toolbarActions}>
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
          <ViewRouter activeView={activeView} projectId={id!} onViewChange={handleViewChange} agentId={activeAgentId} skillId={project.skillId} />
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
        <ChatPanel key={id} projectId={id!} agentId={activeAgentId} onAgentChange={setActiveAgentId} skillId={project.skillId} stage={project.currentStage} onStageChange={handleViewChange} />
      </div>
    </div>
  );
}
