import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@linaria/core';
import { toast } from 'sonner';
import { useProjects, useCreateProject, useDeleteProject, type ProjectWithMeta } from '@/hooks/useProject';
import { pageContainer, pageTitle, card, primaryBtn, input, emptyState } from '@/styles/shared';
import NavHeader from '@/web/components/NavHeader';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 1rem;
`;

const projectCard = css`
  cursor: pointer;
  position: relative;
  &:hover { border-color: var(--haze-color-primary); }
  &:hover .delete-btn { opacity: 1; }
`;

const projectPath = css`
  margin-top: 0.375rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.72rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 0.75rem;
`;

const genreBadge = css`
  display: inline-block;
  background: var(--haze-color-bg-secondary);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-top: 0.5rem;
`;

const searchBar = css`
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex: 1;
  max-width: 400px;
`;

const deleteBtn = css`
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  background: var(--haze-color-error, #ef4444);
  color: white;
  border: none;
  border-radius: 4px;
  width: 24px;
  height: 24px;
  font-size: 0.75rem;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  &:hover { background: #dc2626; }
`;

const pagination = css`
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1.5rem;
  font-size: 0.875rem;
`;

const pageBtn = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--haze-color-text);
  &:hover { background: var(--haze-color-bg-secondary); }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;

const pageInfo = css`
  color: var(--haze-color-text-secondary);
  font-size: 0.8rem;
`;

const genreLabels: Record<string, string> = {
  general: '通用',
  wuxia: '武侠',
  fantasy: '奇幻',
  scifi: '科幻',
  romance: '言情',
  mystery: '悬疑',
  horror: '恐怖',
  historical: '历史',
  reality: '现实',
};

const PAGE_SIZE = 12;

export default function HomePage() {
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('general');
  const [targetWords, setTargetWords] = useState('100000');
  const [chapterCount, setChapterCount] = useState('20');
  const [projectPath, setProjectPath] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [showImportText, setShowImportText] = useState(false);
  const [importTextPath, setImportTextPath] = useState('');
  const [importTextTitle, setImportTextTitle] = useState('');
  const [importTextGenre, setImportTextGenre] = useState('');

  const filtered = useMemo(() => {
    if (!projects) return [];
    if (!search.trim()) return projects;
    const q = search.trim().toLowerCase();
    return projects.filter((p) =>
      p.title.toLowerCase().includes(q) || (p.genre && p.genre.toLowerCase().includes(q))
    );
  }, [projects, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleCreate = () => {
    if (!title.trim() || !projectPath.trim()) return;
    createProject.mutate({
      title: title.trim(),
      path: projectPath.trim(),
      genre,
      targetWords: parseInt(targetWords) || 100000,
      chapterCount: parseInt(chapterCount) || 20,
    }, {
      onSuccess: (data) => {
        setShowCreate(false);
        setTitle('');
        setProjectPath('');
        navigate(`/projects/${data.project.id}`);
      },
    });
  };

  const handleDelete = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    toast(`确定删除「${name}」？`, {
      description: '此操作不可撤销',
      action: {
        label: '删除',
        onClick: () => {
          deleteProject.mutate(id, {
            onSuccess: () => toast.success('已删除'),
          });
        },
      },
    });
  };

  const handleImport = async () => {
    if (!importPath.trim()) return;
    try {
      const res = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: importPath.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowImport(false);
        setImportPath('');
        toast.success('导入成功');
        navigate(`/projects/${data.project.id}`);
      } else {
        toast.error(data.error || '导入失败');
      }
    } catch {
      toast.error('导入失败');
    }
  };

  const handleImportText = async () => {
    if (!importTextPath.trim()) {
      toast.error('请输入源文本路径');
      return;
    }
    try {
      const res = await fetch('/api/projects/import-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: importTextPath.trim(),
          title: importTextTitle.trim() || undefined,
          genre: importTextGenre || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowImportText(false);
        setImportTextPath('');
        setImportTextTitle('');
        setImportTextGenre('');
        toast.success('已开始拆书，agent 正在分析');
        navigate(`/projects/${data.project.id}`);
      } else {
        toast.error(data.error || '导入失败');
      }
    } catch {
      toast.error('导入失败');
    }
  };

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      <NavHeader />
      <div className={pageContainer}>
      <div className={header}>
        <h1 className={pageTitle}>我的小说</h1>
        <div className={searchBar}>
          <input className={input} placeholder="搜索项目..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <button className={primaryBtn} onClick={() => setShowCreate(true)}>新建项目</button>
        <button className={primaryBtn} onClick={() => setShowImport(true)} style={{ background: 'var(--haze-color-bg-secondary)', color: 'var(--haze-color-text)' }}>打开项目</button>
        <button className={primaryBtn} onClick={() => setShowImportText(true)}>导入项目</button>
      </div>

      {showCreate && (
        <div className={card} style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <input className={input} placeholder="小说标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>类型</label>
              <select className={input} value={genre} onChange={(e) => setGenre(e.target.value)} style={{ width: '100%' }}>
                <option value="general">通用</option>
                <option value="wuxia">武侠</option>
                <option value="fantasy">奇幻</option>
                <option value="scifi">科幻</option>
                <option value="romance">言情</option>
                <option value="mystery">悬疑</option>
                <option value="reality">现实</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>目标字数</label>
              <input className={input} type="number" value={targetWords} onChange={(e) => setTargetWords(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>章节数</label>
              <input className={input} type="number" value={chapterCount} onChange={(e) => setChapterCount(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                项目目录
              </label>
              <input
                className={input}
                placeholder="/home/user/novels/my-novel"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
            <button className={primaryBtn} onClick={handleCreate}>创建</button>
            <button onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </div>
      )}

      {showImport && (
        <div className={card} style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                项目目录（包含 .novel/ 结构）
              </label>
              <input
                className={input}
                placeholder="/home/user/novels/my-novel"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleImport()}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
            <button className={primaryBtn} onClick={handleImport}>打开</button>
            <button onClick={() => { setShowImport(false); setImportPath(''); }}>取消</button>
          </div>
        </div>
      )}

      {showImportText && (
        <div className={card} style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                源文本路径（.txt/.md 文件或包含此类文件的目录）
              </label>
              <input
                className={input}
                placeholder="/home/user/novels/my-book.txt 或目录路径"
                value={importTextPath}
                onChange={(e) => setImportTextPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleImportText()}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                  标题（可选，留空自动识别）
                </label>
                <input
                  className={input}
                  placeholder="自动识别"
                  value={importTextTitle}
                  onChange={(e) => setImportTextTitle(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                  类型（可选，留空自动识别）
                </label>
                <select
                  className={input}
                  value={importTextGenre}
                  onChange={(e) => setImportTextGenre(e.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">自动识别</option>
                  <option value="general">通用</option>
                  <option value="wuxia">武侠</option>
                  <option value="fantasy">奇幻</option>
                  <option value="scifi">科幻</option>
                  <option value="romance">言情</option>
                  <option value="mystery">悬疑</option>
                  <option value="reality">现实</option>
                </select>
              </div>
            </div>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
            <button className={primaryBtn} onClick={handleImportText}>开始拆书</button>
            <button onClick={() => { setShowImportText(false); setImportTextPath(''); }}>取消</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className={emptyState}>加载中...</div>
      ) : filtered.length === 0 ? (
        <div className={emptyState}>{search ? '没有匹配的项目' : '还没有项目，点击"新建项目"开始创作'}</div>
      ) : (
        <>
          <div className={grid}>
            {paged.map((p) => (
              <div key={p.id} className={`${card} ${projectCard}`} onClick={() => navigate(`/projects/${p.id}`)}>
                <button className={`delete-btn ${deleteBtn}`} onClick={(e) => handleDelete(e, p.id, p.title)} title="删除项目">
                  &times;
                </button>
                <h3>{p.title}</h3>
                <span className={genreBadge}>{genreLabels[p.genre] || p.genre}</span>
                {p.pathExists === false && (
                  <span style={{ display: 'inline-block', background: '#fef3c7', color: '#92400e', padding: '0.125rem 0.375rem', borderRadius: '4px', fontSize: '0.7rem', marginLeft: '0.5rem' }}>
                    路径不存在
                  </span>
                )}
                <p style={{ marginTop: '0.5rem', color: 'var(--haze-color-text-secondary)', fontSize: '0.875rem' }}>
                  {p.chapterCount} 章 · {p.targetWords.toLocaleString()} 字
                </p>
                <p className={projectPath} title={p.path}>
                  {p.path}
                </p>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className={pagination}>
              <button className={pageBtn} disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <span className={pageInfo}>{page} / {totalPages}</span>
              <button className={pageBtn} disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}
