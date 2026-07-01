import { css } from '@linaria/core';
import { useTheme } from '@/web/hooks/useTheme';

const button = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

const icon = css`
  font-size: 0.875rem;
`;

export default function ThemeToggle() {
  const { theme, cycleTheme } = useTheme();

  const icons = { light: '☀', dark: '☾', system: '⚙' };
  const labels = { light: 'Light', dark: 'Dark', system: 'Auto' };

  return (
    <button className={button} onClick={cycleTheme} title={`Theme: ${labels[theme]}`}>
      <span className={icon}>{icons[theme]}</span>
      <span>{labels[theme]}</span>
    </button>
  );
}
