import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@linaria/core';
import { useProjects, useCreateProject, useDeleteProject } from '@/hooks/useProject';
import { pageContainer, pageTitle, card, primaryBtn, input, emptyState } from '@/styles/shared';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
`;

const projectCard = css`
  cursor: pointer;
  &:hover { border-color: var(--haze-color-primary); }
`;

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
`;

const genreBadge = css`
  display: inline-block;
  background: var(--haze-color-bg-secondary);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-top: 0.5rem;
`;

export default function HomePage() {
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');

  const handleCreate = () => {
    if (!title.trim()) return;
    createProject.mutate({ title: title.trim() }, {
      onSuccess: (data) => {
        setShowCreate(false);
        setTitle('');
        navigate(`/projects/${data.project.id}`);
      },
    });
  };

  return (
    <div className={pageContainer}>
      <div className={header}>
        <h1 className={pageTitle}>我的小说</h1>
        <button className={primaryBtn} onClick={() => setShowCreate(true)}>新建项目</button>
      </div>

      {showCreate && (
        <div className={card} style={{ marginBottom: '1rem' }}>
          <input className={input} placeholder="小说标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
            <button className={primaryBtn} onClick={handleCreate}>创建</button>
            <button onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className={emptyState}>加载中...</div>
      ) : !projects?.length ? (
        <div className={emptyState}>还没有项目，点击"新建项目"开始创作</div>
      ) : (
        <div className={grid}>
          {projects.map((p: any) => (
            <div key={p.id} className={`${card} ${projectCard}`} onClick={() => navigate(`/projects/${p.id}`)}>
              <h3>{p.title}</h3>
              <span className={genreBadge}>{p.genre}</span>
              <p style={{ marginTop: '0.5rem', color: 'var(--haze-color-text-secondary)', fontSize: '0.875rem' }}>
                {p.chapterCount} 章 · {p.targetWords.toLocaleString()} 字
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
