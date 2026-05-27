import { useState, useRef, useEffect } from 'react';
import { css } from '@linaria/core';
import { useRun } from '@/web/hooks/useRun';
import AgentMessage from './AgentMessage';

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const messages = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
`;

const inputArea = css`
  border-top: 1px solid var(--haze-color-border);
  padding: 0.75rem;
  display: flex;
  gap: 0.5rem;
`;

const textarea = css`
  flex: 1;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem;
  resize: none;
  font-family: inherit;
  font-size: 0.875rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
`;

const sendBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

interface Props {
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
}

export default function ChatPanel({ projectId, agentId, skillId, stage }: Props) {
  const { messages: chatMessages, isRunning, sendMessage } = useRun();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleSend = () => {
    if (!input.trim() || isRunning) return;
    sendMessage({ projectId, agentId, skillId, stage, message: input.trim() });
    setInput('');
  };

  return (
    <div className={panel}>
      <div className={messages}>
        {chatMessages.map((msg, i) => (
          <AgentMessage key={i} role={msg.role} content={msg.content} toolUse={msg.toolUse} thinking={msg.thinking} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className={inputArea}>
        <textarea className={textarea} rows={2} placeholder="输入消息..." value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())} />
        <button className={sendBtn} onClick={handleSend} disabled={isRunning}>发送</button>
      </div>
    </div>
  );
}
