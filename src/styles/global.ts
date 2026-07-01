import { css } from '@linaria/core';

export const globalStyles = css`
  :global() {
    :root {
      --haze-color-primary: #6366f1;
      --haze-color-primary-hover: #4f46e5;
      --haze-color-bg: #ffffff;
      --haze-color-bg-secondary: #f9fafb;
      --haze-color-text: #111827;
      --haze-color-text-secondary: #6b7280;
      --haze-color-border: #e5e7eb;
      --haze-color-error: #ef4444;
      --haze-color-success: #22c55e;
      --haze-color-warning: #f59e0b;
      --haze-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --haze-font-mono: 'SF Mono', 'Fira Code', monospace;
    }

    /* Auto dark mode via media query */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --haze-color-primary: #818cf8;
        --haze-color-primary-hover: #6366f1;
        --haze-color-bg: #111827;
        --haze-color-bg-secondary: #1f2937;
        --haze-color-text: #f9fafb;
        --haze-color-text-secondary: #9ca3af;
        --haze-color-border: #374151;
      }
    }

    /* Manual dark mode */
    :root[data-theme="dark"] {
      --haze-color-primary: #818cf8;
      --haze-color-primary-hover: #6366f1;
      --haze-color-bg: #111827;
      --haze-color-bg-secondary: #1f2937;
      --haze-color-text: #f9fafb;
      --haze-color-text-secondary: #9ca3af;
      --haze-color-border: #374151;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; width: 100%; }
    body { font-family: var(--haze-font-sans); background: var(--haze-color-bg); color: var(--haze-color-text); }
    a { color: var(--haze-color-primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
  }
`;
