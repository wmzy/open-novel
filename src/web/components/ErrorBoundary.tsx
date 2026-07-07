import { Component, type ReactNode } from 'react';
import { css } from '@linaria/core';

const container = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  text-align: center;
`;

const title = css`
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--haze-color-error, #ef4444);
`;

const message = css`
  font-size: 0.875rem;
  color: var(--haze-color-text-secondary);
  margin-bottom: 1rem;
  max-width: 400px;
`;

const retryBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1.5rem;
  cursor: pointer;
  font-size: 0.875rem;
  &:hover { background: var(--haze-color-primary-hover); }
`;

const details = css`
  margin-top: 1rem;
  padding: 1rem;
  background: var(--haze-color-bg-secondary);
  border-radius: 6px;
  font-family: var(--haze-font-mono);
  font-size: 0.75rem;
  text-align: left;
  max-width: 600px;
  overflow: auto;
  color: var(--haze-color-text-secondary);
`;

const errorStack = css`
  margin-top: 0.5rem;
  font-size: 0.7rem;
`;

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className={container}>
          <div className={title}>出现错误</div>
          <div className={message}>
            发生了一个意外错误。你可以尝试重新加载组件或刷新页面。
          </div>
          <button className={retryBtn} onClick={this.handleRetry}>
            重试
          </button>
          {this.state.error && (
            <details className={details}>
              <summary>错误详情</summary>
              <pre>{this.state.error.message}</pre>
              {this.state.error.stack && (
                <pre className={errorStack}>
                  {this.state.error.stack}
                </pre>
              )}
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
