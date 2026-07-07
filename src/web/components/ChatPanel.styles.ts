import { css } from '@linaria/core';

export const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  @media (max-width: 768px) {
    height: 50vh;
    min-height: 300px;
  }
`;

export const toolbar = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  flex-wrap: wrap;
  @media (max-width: 768px) {
    padding: 0.375rem 0.5rem;
    gap: 0.375rem;
  }
`;

export const select = css`
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  font-size: 0.75rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
  max-width: 180px;
  &:disabled { opacity: 0.5; }
`;

export const iconBtn = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
  flex-shrink: 0;
  &:hover { background: var(--haze-color-border); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

export const messages = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
`;

export const statusStrip = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 1rem;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  background: var(--haze-color-bg);
  border-top: 1px solid var(--haze-color-border);
`;

export const statusDot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--haze-color-primary);
  animation: pulse 1.5s infinite;
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
`;

export const inputArea = css`
  border-top: 1px solid var(--haze-color-border);
  padding: 0.75rem;
  display: flex;
  gap: 0.5rem;
  position: relative;
`;

export const textarea = css`
  flex: 1;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem;
  resize: none;
  font-family: inherit;
  font-size: 0.875rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:disabled { opacity: 0.5; }
`;

export const sendBtn = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

export const stopBtn = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: var(--haze-color-error, #ef4444);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
`;

export const jumpBtn = css`
  position: absolute;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 20px;
  padding: 0.35rem 1rem;
  font-size: 0.75rem;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  z-index: 10;
`;

export const emptyState = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
  text-align: center;
  gap: 0.5rem;
`;

/** 修订模式提示条：视图/卡片 ✎ dispatch 后显示，标明修订目标。 */
export const reviseBanner = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.4rem;
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.78rem;
  color: var(--haze-color-text);
`;

export const reviseBannerClose = css`
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  font-size: 0.9rem;
  padding: 0 0.25rem;
  &:hover {
    color: var(--haze-color-text);
  }
`;

export const agentWarning = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  color: var(--haze-color-error, #ef4444);
  background: var(--haze-color-bg);
  border-top: 1px solid var(--haze-color-border);
`;

export const agentBadge = css`
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  font-size: 0.625rem;
  background: var(--haze-color-primary);
  color: white;
  text-transform: uppercase;
  letter-spacing: 0.02em;
`;

export const autocompleteDropdown = css`
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 4px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 20;
  box-shadow: 0 -4px 12px rgba(0,0,0,0.1);
`;

export const autocompleteItem = css`
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  &:hover, &[data-active="true"] {
    background: var(--haze-color-border);
  }
`;

export const autocompleteCmd = css`
  font-weight: 600;
  color: var(--haze-color-primary);
  font-family: monospace;
  white-space: nowrap;
`;

export const autocompleteDesc = css`
  color: var(--haze-color-text-secondary);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const cmdBadge = css`
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.0625rem 0.3rem;
  border-radius: 0.25rem;
  margin-left: auto;
  white-space: nowrap;
`;

export const cmdBadgeApp = css`
  background: color-mix(in srgb, var(--haze-color-primary) 14%, transparent);
  color: var(--haze-color-primary);
`;

export const cmdBadgeAgent = css`
  background: color-mix(in srgb, var(--haze-color-text-secondary) 14%, transparent);
  color: var(--haze-color-text-secondary);
`;

export const askBox = css`
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--haze-color-border);
  background: color-mix(in srgb, var(--haze-color-primary) 5%, var(--haze-color-bg));
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

export const askMessage = css`
  font-size: 0.875rem;
  color: var(--haze-color-text);
  white-space: pre-wrap;
  line-height: 1.4;
`;

export const askOptions = css`
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

export const askOptionBtn = css`
  text-align: left;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 0.8125rem;
  cursor: pointer;
  &:hover {
    border-color: var(--haze-color-primary);
    background: color-mix(in srgb, var(--haze-color-primary) 8%, var(--haze-color-bg));
  }
`;

export const askCheckbox = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  font-size: 0.8125rem;
  cursor: pointer;
  &:hover {
    border-color: var(--haze-color-primary);
  }
  input {
    margin: 0;
    accent-color: var(--haze-color-primary);
  }
`;

export const askInput = css`
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.8125rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
  }
`;

export const askActions = css`
  display: flex;
  gap: 0.5rem;
`;

export const askSubmitBtn = css`
  padding: 0.375rem 1rem;
  border: none;
  border-radius: 6px;
  background: var(--haze-color-primary);
  color: white;
  font-size: 0.8125rem;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

export const askCancelBtn = css`
  padding: 0.375rem 1rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 0.8125rem;
  cursor: pointer;
  &:hover { background: var(--haze-color-border); }
`;
