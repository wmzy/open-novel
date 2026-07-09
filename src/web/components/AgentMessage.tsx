import { useState, useEffect } from 'react';
import { css, cx } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ToolCard, { toolFamily } from './ToolCard';
import FileOpsSummary from './FileOpsSummary';
import type { AgentEvent } from '@/agent/types';

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
  background: var(--haze-color-bg-secondary, #f5f5f5);
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

const thinkingToggle = css`
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  padding: 0;
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

const toolGroup = css`
  margin-top: 0.5rem;
`;

const toolGroupPill = css`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  margin-top: 0.5rem;
`;

const statusPill = css`
  display: inline-block;
  font-size: 0.7rem;
  color: var(--haze-color-text-secondary);
  background: var(--haze-color-bg);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  margin-top: 0.25rem;
`;

const waitingPill = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  padding: 0.5rem 0;
`;

const waitingDot = css`
  width: 8px;
  height: 8px;
  background: var(--haze-color-primary);
  border-radius: 50%;
  animation: pulse 1.5s infinite;
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
`;

const footer = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.7rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--haze-color-border);
`;

const errorBanner = css`
  background: var(--haze-color-error, #fef2f2);
  color: var(--haze-color-error, #ef4444);
  border: 1px solid var(--haze-color-error, #fecaca);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  margin-top: 0.5rem;
`;

/** 消息列表顶部 Edit 按钮 */
const editBtn = css`
  background: none;
  border: none;
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  font-size: 0.7rem;
  margin-left: 0.5rem;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
`;

/** 底部操作行 */
const actionRow = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
`;

/** 回复按钮 */
const replyBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 0.7rem;
  padding: 0.125rem 0.5rem;
`;

/** thinking 代码块 pre */
const thinkingPre = css`
  white-space: pre-wrap;
  margin: 0;
`;

/** thinking 折叠态 */
const thinkingCollapsed = css`
  opacity: 0.7;
`;

/** 工具组 Done 标记 */
const doneMark = css`
  color: var(--haze-color-success, #22c55e);
`;

/** 等待提示（This may take a while） */
const waitingHint = css`
  font-size: 0.7rem;
  opacity: 0.6;
`;

interface Props {
  role: 'user' | 'assistant';
  content: string;
  events?: AgentEvent[];
  startedAt?: number;
  endedAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  error?: string;
  artifacts?: { count: number; paths: string[] };
  onResend?: (content: string) => void;
  onReply?: (content: string) => void;
  onBranch?: () => void;
}

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-group'; items: Array<{ use: AgentEvent & { kind: 'tool_use' }; result?: AgentEvent & { kind: 'tool_result' } }> }
  | { kind: 'status'; label: string; detail?: string };

export function buildBlocks(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < events.length) {
    const ev = events[i];

    if (ev.kind === 'text') {
      // Merge consecutive text events
      let text = ev.text;
      while (i + 1 < events.length && events[i + 1].kind === 'text') {
        i++;
        text += (events[i] as { kind: 'text'; text: string }).text;
      }
      blocks.push({ kind: 'text', text });
      i++;
      continue;
    }

    if (ev.kind === 'thinking') {
      let text = ev.text;
      while (i + 1 < events.length && events[i + 1].kind === 'thinking') {
        i++;
        text += (events[i] as { kind: 'thinking'; text: string }).text;
      }
      blocks.push({ kind: 'thinking', text });
      i++;
      continue;
    }

    if (ev.kind === 'tool_use') {
      // Collect consecutive tool_uses of the same family
      const family = toolFamily(ev.name);
      const items: Array<{ use: AgentEvent & { kind: 'tool_use' }; result?: AgentEvent & { kind: 'tool_result' } }> = [];

      // Find matching tool_result
      const findResult = (toolUseId: string): (AgentEvent & { kind: 'tool_result' }) | undefined => {
        for (let j = i + 1; j < events.length; j++) {
          if (events[j].kind === 'tool_result' && (events[j] as { kind: 'tool_result'; toolUseId: string }).toolUseId === toolUseId) {
            return events[j] as AgentEvent & { kind: 'tool_result' };
          }
        }
        return undefined;
      };

      items.push({ use: ev as AgentEvent & { kind: 'tool_use' }, result: findResult(ev.id) });

      // Look ahead for more tool_uses of the same family
      while (i + 1 < events.length && events[i + 1].kind === 'tool_use') {
        const next = events[i + 1] as AgentEvent & { kind: 'tool_use' };
        if (toolFamily(next.name) !== family) break;
        i++;
        items.push({ use: next, result: findResult(next.id) });
      }

      blocks.push({ kind: 'tool-group', items });
      i++;
      continue;
    }

    if (ev.kind === 'status') {
      blocks.push({ kind: 'status', label: ev.label, detail: ev.detail });
      i++;
      continue;
    }

    // Skip tool_result, usage, raw - they're handled inline
    i++;
  }

  return blocks;
}

export default function AgentMessage({ role, content, events, startedAt, endedAt, usage, error, artifacts, onResend, onReply }: Props) {
  if (role === 'user') {
    return (
      <div className={messageBlock}>
        <div className={userMsg}>
          {content}
          {onResend && (
            <button
              onClick={() => onResend(content)}
              className={editBtn}
              title="Edit and resend"
            >
              Edit
            </button>
          )}
        </div>
      </div>
    );
  }

  const blocks = events?.length ? buildBlocks(events) : (content ? [{ kind: 'text' as const, text: content }] : []);
  const hasContent = blocks.length > 0 || content;

  return (
    <div className={messageBlock}>
      <div className={assistantMsg}>
        {artifacts && artifacts.count > 0 && (
          <FileOpsSummary count={artifacts.count} paths={artifacts.paths} />
        )}

        {blocks.map((block, i) => {
          if (block.kind === 'text') return <TextBlock key={i} text={block.text} />;
          if (block.kind === 'thinking') return <ThinkingBlock key={i} text={block.text} />;
          if (block.kind === 'tool-group') return <ToolGroupBlock key={i} items={block.items} />;
          if (block.kind === 'status') return <div key={i} className={statusPill}>{block.label}{block.detail ? `: ${block.detail}` : ''}</div>;
          return null;
        })}

        {!hasContent && !error && startedAt && !endedAt && <WaitingPill startedAt={startedAt} />}

        {error && <div className={errorBanner}>{error}</div>}

        <div className={actionRow}>
          {onReply && content && (
            <button
              onClick={() => onReply(content)}
              className={replyBtn}
              title="Reply to this message"
            >
              Reply
            </button>
          )}
          {(usage || startedAt) && (
            <AssistantFooter startedAt={startedAt} endedAt={endedAt} usage={usage} />
          )}
        </div>
      </div>
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>;
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 140 ? text.slice(0, 140) + '...' : text;

  return (
    <div>
      <button className={thinkingToggle} onClick={() => setExpanded(!expanded)}>
        {expanded ? '[-]' : '[+]'} Thinking
      </button>
      {expanded ? (
        <div className={thinkingBlock}><pre className={thinkingPre}>{text}</pre></div>
      ) : (
        <div className={cx(thinkingBlock, thinkingCollapsed)}>{preview}</div>
      )}
    </div>
  );
}

function ToolGroupBlock({ items }: { items: Array<{ use: AgentEvent & { kind: 'tool_use' }; result?: AgentEvent & { kind: 'tool_result' } }> }) {
  const [expanded, setExpanded] = useState(items.length <= 1);

  if (items.length === 1) {
    return (
      <div className={toolGroup}>
        <ToolCard use={items[0].use} result={items[0].result} streaming={!items[0].result} />
      </div>
    );
  }

  const family = toolFamily(items[0].use.name);
  const doneCount = items.filter((it) => it.result).length;
  const allDone = doneCount === items.length;

  return (
    <div className={toolGroup}>
      <button className={toolGroupPill} onClick={() => setExpanded(!expanded)}>
        {expanded ? '[-]' : '[+]'} {familyIcon(family)} {capitalize(family)} x{items.length}
        {allDone && <span className={doneMark}> Done</span>}
      </button>
      {expanded && items.map((item, i) => (
        <ToolCard key={item.use.id || i} use={item.use} result={item.result} streaming={!item.result} />
      ))}
    </div>
  );
}

function WaitingPill({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [startedAt]);

  const seconds = Math.floor(elapsed / 1000);

  return (
    <div className={waitingPill}>
      <span className={waitingDot} />
      <span>Thinking{seconds > 0 ? ` ${seconds}s` : ''}...</span>
      {seconds > 12 && <span className={waitingHint}>This may take a while</span>}
    </div>
  );
}

function AssistantFooter({ startedAt, endedAt, usage }: {
  startedAt?: number;
  endedAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}) {
  const elapsed = startedAt ? (endedAt || Date.now()) - startedAt : 0;

  return (
    <div className={footer}>
      {elapsed > 0 && <span>{formatElapsed(elapsed)}</span>}
      {usage?.inputTokens != null && <span>In: {usage.inputTokens.toLocaleString()}</span>}
      {usage?.outputTokens != null && <span>Out: {usage.outputTokens.toLocaleString()}</span>}
      {usage?.costUsd != null && <span>${usage.costUsd.toFixed(4)}</span>}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function familyIcon(family: string): string {
  const map: Record<string, string> = {
    write: '+', edit: '~', read: '?', bash: '$', glob: '*', grep: '/', fetch: '@', search: '?',
  };
  return map[family] || '>';
}
