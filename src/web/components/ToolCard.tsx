import { useState } from 'react';
import { css } from '@linaria/core';
import type { AgentEvent } from '@/agent/types';

const card = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-top: 0.5rem;
  font-size: 0.8rem;
`;

const cardHeader = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const toolIcon = css`
  font-size: 0.75rem;
  opacity: 0.7;
`;

const toolName = css`
  font-weight: 600;
  color: var(--haze-color-primary);
`;

const badge = css`
  font-size: 0.65rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  margin-left: auto;
`;

const badgeRunning = css`
  background: var(--haze-color-primary);
  color: white;
  animation: pulse 1.5s infinite;
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

const badgeDone = css`
  background: var(--haze-color-success, #22c55e);
  color: white;
`;

const badgeError = css`
  background: var(--haze-color-error, #ef4444);
  color: white;
`;

const detail = css`
  margin-top: 0.35rem;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

const output = css`
  margin-top: 0.35rem;
  font-size: 0.75rem;
  background: var(--haze-color-bg-secondary, #f5f5f5);
  border-radius: 4px;
  padding: 0.5rem;
  overflow: auto;
  max-height: 200px;
  white-space: pre-wrap;
  word-break: break-all;
`;

const expandBtn = css`
  background: none;
  border: none;
  color: var(--haze-color-primary);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  margin-top: 0.25rem;
`;

const questionCard = css`
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
`;

const optionBtn = css`
  display: block;
  width: 100%;
  text-align: left;
  background: var(--haze-color-bg-secondary, #f5f5f5);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-top: 0.35rem;
  cursor: pointer;
  font-size: 0.8rem;
  &:hover { border-color: var(--haze-color-primary); }
`;

const selectedOption = css`
  border-color: var(--haze-color-primary);
  background: var(--haze-color-primary);
  color: white;
`;

interface Props {
  use: AgentEvent & { kind: 'tool_use' };
  result?: AgentEvent & { kind: 'tool_result' };
  streaming?: boolean;
  runId?: string | null;
}

export default function ToolCard({ use, result, streaming, runId }: Props) {
  const name = use.name;
  const input = (use.input || {}) as Record<string, unknown>;

  // AskUserQuestion / question interactive card
  if (name === 'AskUserQuestion' || name === 'ask_user_question' || name === 'question') {
    return <AskUserQuestionCard use={use} result={result} streaming={streaming} runId={runId} />;
  }

  const family = toolFamily(name);
  const status: 'running' | 'done' | 'error' = result ? (result.isError ? 'error' : 'done') : streaming ? 'running' : 'done';

  const statusLabel = {
    running: family === 'read' ? 'Reading...' : family === 'write' ? 'Writing...' : family === 'edit' ? 'Editing...' : family === 'bash' ? 'Running...' : 'Working...',
    error: 'Error',
    done: 'Done',
  };

  return (
    <div className={card}>
      <div className={cardHeader}>
        <span className={toolIcon}>{familyIcon(family)}</span>
        <span className={toolName}>{displayName(name)}</span>
        <span className={`${badge} ${status === 'running' ? badgeRunning : status === 'error' ? badgeError : badgeDone}`}>
          {statusLabel[status]}
        </span>
      </div>
      {renderDetail(family, input)}
      {result && !result.isError && result.content && (
        <OutputBlock content={result.content} />
      )}
      {result?.isError && result.content && (
        <div className={output} style={{ color: 'var(--haze-color-error, #ef4444)' }}>{truncate(result.content, 4000)}</div>
      )}
    </div>
  );
}

function AskUserQuestionCard({ use, result, runId }: Props) {
  const input = (use.input || {}) as Record<string, unknown>;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  // Recover from result if already answered
  if (result && !submitted) {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed && typeof parsed === 'object') {
        // Already answered, show as locked
      }
    } catch { /* ignore */ }
  }

  const handleSubmit = async () => {
    if (!runId) return;
    setSubmitted(true);
    await fetch(`/api/runs/${runId}/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolUseId: use.id,
        content: JSON.stringify(answers),
      }),
    });
  };

  if (result || submitted) {
    return (
      <div className={questionCard}>
        <div style={{ fontSize: '0.8rem', color: 'var(--haze-color-text-secondary)' }}>
          Answered
        </div>
      </div>
    );
  }

  return (
    <div className={questionCard}>
      {questions.map((q: Record<string, unknown>, qi: number) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const multiSelect = q.multiSelect === true;
        return (
          <div key={qi}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              {q.header ? <span style={{ color: 'var(--haze-color-primary)', marginRight: '0.5rem' }}>{String(q.header)}</span> : null}
              {String(q.question)}
            </div>
            {options.map((opt: Record<string, unknown>, oi: number) => {
              const selected = answers[qi] === String(opt.label);
              return (
                <button
                  key={oi}
                  className={`${optionBtn} ${selected ? selectedOption : ''}`}
                  onClick={() => {
                    if (multiSelect) {
                      setAnswers((prev) => ({ ...prev, [qi]: String(opt.label) }));
                    } else {
                      setAnswers((prev) => ({ ...prev, [qi]: String(opt.label) }));
                    }
                  }}
                >
                  <strong>{String(opt.label)}</strong>
                  {opt.description ? <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>{String(opt.description)}</div> : null}
                </button>
              );
            })}
          </div>
        );
      })}
      <button
        className={optionBtn}
        style={{ marginTop: '0.75rem', background: 'var(--haze-color-primary)', color: 'white', border: 'none', textAlign: 'center' }}
        onClick={handleSubmit}
        disabled={Object.keys(answers).length === 0}
      >
        Submit
      </button>
    </div>
  );
}

function OutputBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncate(content, 300);
  const needsExpand = content.length > 300;

  return (
    <div className={output}>
      {expanded ? content : truncated}
      {needsExpand && (
        <button className={expandBtn} onClick={() => setExpanded(!expanded)}>
          {expanded ? '[-] Collapse' : `[+] Expand (${content.length} chars)`}
        </button>
      )}
    </div>
  );
}

function renderDetail(family: string, input: Record<string, unknown>) {
  switch (family) {
    case 'write':
      return <div className={detail}>{icon('+')} {filePath(input)}</div>;
    case 'edit':
      return <div className={detail}>{icon('~')} {filePath(input)}</div>;
    case 'read':
      return <div className={detail}>{icon('?')} {filePath(input)}</div>;
    case 'bash':
      return <div className={detail}>{icon('$')} {truncate(String(input.command || ''), 400)}</div>;
    case 'glob':
      return <div className={detail}>{icon('*')} {String(input.pattern || '')} {input.path ? `in ${input.path}` : ''}</div>;
    case 'grep':
      return <div className={detail}>{icon('/')} {String(input.pattern || '')} {input.path ? `in ${input.path}` : ''}</div>;
    case 'fetch':
      return <div className={detail}>{icon('@')} {truncate(String(input.url || ''), 200)}</div>;
    case 'search':
      return <div className={detail}>{icon('?')} {String(input.query || '')}</div>;
    default:
      return <div className={detail}>{describeInput(input)}</div>;
  }
}

function filePath(input: Record<string, unknown>): string {
  return String(input.file_path || input.path || '');
}

function icon(symbol: string) {
  return <span className={toolIcon}>{symbol}</span>;
}

function displayName(name: string): string {
  const map: Record<string, string> = {
    Write: 'Write', create_file: 'Write',
    Edit: 'Edit', str_replace_edit: 'Edit', MultiEdit: 'Edit',
    Read: 'Read', read_file: 'Read',
    Bash: 'Bash',
    Glob: 'Glob', list_files: 'Glob',
    Grep: 'Grep',
    WebFetch: 'Fetch', web_fetch: 'Fetch',
    WebSearch: 'Search', web_search: 'Search',
    AskUserQuestion: 'Question', ask_user_question: 'Question',
    TodoWrite: 'Todo', todowrite: 'Todo', todo_write: 'Todo',
  };
  return map[name] || name;
}

export function toolFamily(name: string): string {
  const n = name.toLowerCase();
  if (['write', 'create_file'].includes(n)) return 'write';
  if (['edit', 'str_replace_edit', 'multiedit'].includes(n)) return 'edit';
  if (['read', 'read_file'].includes(n)) return 'read';
  if (n === 'bash') return 'bash';
  if (['glob', 'list_files'].includes(n)) return 'glob';
  if (n === 'grep') return 'grep';
  if (['webfetch', 'web_fetch'].includes(n)) return 'fetch';
  if (['websearch', 'web_search'].includes(n)) return 'search';
  if (['askuserquestion', 'ask_user_question'].includes(n)) return 'question';
  if (['todowrite', 'todo_write', 'update_plan'].includes(n)) return 'todo';
  return n;
}

function familyIcon(family: string): string {
  const map: Record<string, string> = {
    write: '+', edit: '~', read: '?', bash: '$', glob: '*', grep: '/', fetch: '@', search: '?', question: '?', todo: '#',
  };
  return map[family] || '>';
}

function describeInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'pattern', 'url', 'query', 'name', 'command']) {
    if (typeof input[key] === 'string' && input[key]) return String(input[key]);
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}
