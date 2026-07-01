import { Link, useLocation } from 'react-router-dom';
import { css } from '@linaria/core';
import ThemeToggle from './ThemeToggle';

const nav = css`
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
`;

const brand = css`
  font-weight: 700;
  font-size: 1rem;
  color: var(--haze-color-text);
  &:hover { text-decoration: none; }
`;

const links = css`
  display: flex;
  gap: 1rem;
`;

const link = css`
  font-size: 0.875rem;
  color: var(--haze-color-text-secondary);
  &:hover { color: var(--haze-color-text); text-decoration: none; }
`;

const activeLink = css`
  color: var(--haze-color-primary);
  font-weight: 500;
`;

export default function NavHeader() {
  const location = useLocation();
  const isActive = (path: string) => location.pathname === path;

  return (
    <nav className={nav}>
      <Link to="/" className={brand}>Open Novel</Link>
      <div className={links}>
        <Link to="/" className={`${link} ${isActive('/') ? activeLink : ''}`}>首页</Link>
        <Link to="/settings" className={`${link} ${isActive('/settings') ? activeLink : ''}`}>设置</Link>
      </div>
      <div style={{ marginLeft: 'auto' }}>
        <ThemeToggle />
      </div>
    </nav>
  );
}
