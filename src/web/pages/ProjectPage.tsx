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
import WuxiaView from '@/web/components/views/WuxiaView';
import WritingView from '@/web/components/views/WritingView';
import { useAgentSelection } from '@/web/hooks/useAgents';

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
  width: 400px;
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

function ViewRouter({ activeView, projectId, onViewChange, agentId }: { activeView: string; projectId: string; onViewChange: (view: string) => void; agentId: string }) {
  if (activeView === 'dashboard') return <DashboardView projectId={projectId} />;
  if (activeView === 'concept') return <ConceptView projectId={projectId} />;
  if (activeView === 'world') return <WorldView projectId={projectId} />;
  if (activeView === 'characters') return <CharacterView projectId={projectId} />;
  if (activeView === 'outline') return <OutlineView projectId={projectId} />;
  if (activeView === 'scenes') return <SceneView projectId={projectId} />;
  if (activeView === 'foreshadow') return <ForeshadowView projectId={projectId} />;
  if (activeView === 'wuxia') return <WuxiaView projectId={projectId} />;
  if (activeView === 'writing') return <WritingView projectId={projectId} onViewChange={onViewChange} />;
  if (activeView.startsWith('chapter-')) {
    const num = parseInt(activeView.replace('chapter-', ''), 10);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <EditorPanel projectId={projectId} chapterNum={num} agentId={agentId} />
        </div>
        <details className={rewriteDetails}>
          <summary className={rewriteSummary}>✍️ 局部重写工作台</summary>
          <RewritePanel projectId={projectId} chapterNum={num} agentId={agentId} />
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

  const queryClient = useQueryClient();
  const { data: project, refetch: refetchProject } = useQuery({
    queryKey: ['project', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      return data.project;
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

  if (!project) return <div>加载中...</div>;

  return (
    <div className={layout}>
      <Sidebar activeView={activeView} onViewChange={handleViewChange} chapters={chapters || []} />
      <div className={main}>
        <div className={topBar}>
          <Link to="/" className={backLink}>← 首页</Link>
          <h2>{project.title}</h2>
          <WorkflowProgress currentStage={project.currentStage} onStageClick={handleViewChange} />
          <div style={{ display: 'flex', gap: '0.375rem', marginLeft: 'auto' }}>
            <button className={previewToggle} onClick={() => handleExport('markdown')} title="导出 Markdown">MD</button>
            <button className={previewToggle} onClick={() => handleExport('text')} title="导出 TXT">TXT</button>
            <button className={previewToggle} onClick={handleUndo} title="撤销上次更改">撤销</button>
            <button className={previewToggle} onClick={handleSync} disabled={syncing} title="同步到远程仓库">
              {syncing ? '同步中...' : '同步'}
            </button>
            <button className={previewToggle} onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? '隐藏预览' : '显示预览'}
            </button>
          </div>
        </div>
        <div className={content}>
          <ViewRouter activeView={activeView} projectId={id!} onViewChange={handleViewChange} agentId={activeAgentId} />
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
      <div className={chatPanel} data-testid="chat-panel">
        <ChatPanel projectId={id!} agentId={activeAgentId} onAgentChange={setActiveAgentId} skillId="novel" stage={project.currentStage} onStageChange={handleViewChange} />
      </div>
    </div>
  );
}
