import { css } from '@linaria/core';

const card = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem;
  margin-top: 0.5rem;
  font-size: 0.8rem;
`;

const toolName = css`
  font-weight: 600;
  color: var(--haze-color-primary);
`;

interface Props {
  name: string;
  input: unknown;
}

export default function ToolCard({ name, input }: Props) {
  return (
    <div className={card}>
      <span className={toolName}>{name}</span>
      <pre style={{ marginTop: '0.25rem', fontSize: '0.75rem', overflow: 'auto' }}>
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}
