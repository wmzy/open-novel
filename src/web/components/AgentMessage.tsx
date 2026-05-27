import { css } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ToolCard from './ToolCard';

const messageBlock = css`
  margin-bottom: 1rem;
`;

const userMsg = css`
  background: var(--haze-color-primary);
  color: white;
  padding: 0.75rem 1rem;
  border-radius: 12px 12px 0 12px;
  max-width: 80%;
  margin-left: auto;
`;

const assistantMsg = css`
  background: var(--haze-color-bg-secondary);
  padding: 0.75rem 1rem;
  border-radius: 12px 12px 12px 0;
  max-width: 90%;
`;

const thinkingBlock = css`
  background: var(--haze-color-bg);
  border: 1px dashed var(--haze-color-border);
  padding: 0.5rem;
  border-radius: 6px;
  margin-bottom: 0.5rem;
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

interface Props {
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ id: string; name: string; input: unknown }>;
  thinking?: string;
}

export default function AgentMessage({ role, content, toolUse, thinking }: Props) {
  return (
    <div className={messageBlock}>
      <div className={role === 'user' ? userMsg : assistantMsg}>
        {thinking && <details className={thinkingBlock}><summary>思考过程</summary><pre>{thinking}</pre></details>}
        {role === 'assistant' ? <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown> : content}
        {toolUse?.map((t) => <ToolCard key={t.id} name={t.name} input={t.input} />)}
      </div>
    </div>
  );
}
