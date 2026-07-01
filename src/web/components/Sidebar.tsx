import { css } from '@linaria/core';
import { ALL_VIEWS } from '@/shared/stages';

const sidebar = css`
  width: 240px;
  border-right: 1px solid var(--haze-color-border);
  padding: 1rem;
  overflow-y: auto;
  height: 100%;
  @media (max-width: 768px) {
    width: 100%;
    height: auto;
    max-height: 200px;
    border-right: none;
    border-bottom: 1px solid var(--haze-color-border);
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.5rem;
  }
`;

const navItem = css`
  display: block;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--haze-color-text);
  &:hover { background: var(--haze-color-bg-secondary); text-decoration: none; }
`;

const navItemActive = css`
  background: var(--haze-color-bg-secondary);
  font-weight: 500;
`;

const sectionTitle = css`
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--haze-color-text-secondary);
  margin: 1rem 0 0.5rem;
`;

interface Props {
  activeView: string;
  onViewChange: (view: string) => void;
  chapters: Array<{ number: number; title: string | null }>;
}

export default function Sidebar({ activeView, onViewChange, chapters }: Props) {
  const views = ALL_VIEWS;

  return (
    <div className={sidebar} data-testid="sidebar">
      <div className={sectionTitle}>文档</div>
      {views.map((v) => (
        <a key={v.id} className={`${navItem} ${activeView === v.id ? navItemActive : ''}`} onClick={() => onViewChange(v.id)}>
          {v.label}
        </a>
      ))}
      {chapters.length > 0 && (
        <>
          <div className={sectionTitle}>章节</div>
          {chapters.map((ch) => (
            <a key={ch.number} className={`${navItem} ${activeView === `chapter-${ch.number}` ? navItemActive : ''}`} onClick={() => onViewChange(`chapter-${ch.number}`)}>
              第{ch.number}章 {ch.title || ''}
            </a>
          ))}
        </>
      )}
    </div>
  );
}
