import { css } from '@linaria/core';

export const pageContainer = css`
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
  width: 100%;
`;

export const pageTitle = css`
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 1.5rem;
`;

export const card = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.5rem;
`;

export const primaryBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.875rem;
  &:hover { background: var(--haze-color-primary-hover); }
`;

export const input = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  width: 100%;
`;

export const emptyState = css`
  text-align: center;
  padding: 3rem;
  color: var(--haze-color-text-secondary);
`;
