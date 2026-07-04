import { useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { useRun } from '@/web/hooks/useRun';
import { useModels } from '@/web/hooks/useModels';
import { useConversations } from '@/web/hooks/useConversations';
import { useAgents } from '@/web/hooks/useAgents';
import { useAgentCommands } from '@/web/hooks/useAgentCommands';
import { useFileAutocomplete } from '@/web/hooks/useFileAutocomplete';
import AgentMessage from './AgentMessage';
import RevisionDiffPanel from './RevisionDiffPanel';
import {
  panel, toolbar, select, iconBtn, messages, statusStrip, statusDot,
  inputArea, textarea, sendBtn, stopBtn, jumpBtn, emptyState,
  agentWarning, agentBadge, autocompleteDropdown, autocompleteItem,
  autocompleteCmd, autocompleteDesc, cmdBadge, cmdBadgeApp, cmdBadgeAgent,
  askBox, askMessage, askOptions, askOptionBtn, askCheckbox, askInput,
  askActions, askSubmitBtn, askCancelBtn,
} from './ChatPanel.styles';

interface Command {
  name: string;
  description: string;
  action?: () => void;
  source?: 'app' | 'agent';
}

interface Props {
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  onStageChange?: (stage: string) => void;
  onAgentChange?: (agentId: string) => void;
}

const DEFAULT_MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
];

export default function ChatPanel({ projectId, agentId, skillId, stage, onStageChange, onAgentChange }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [selectedModel, setSelectedModel] = useState('default');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeCmdIndex, setActiveCmdIndex] = useState(0);
  const [showCommands, setShowCommands] = useState(false);

  // ask 选择框临时状态（多选的已选项、输入的文本）
  const [askMultiSelected, setAskMultiSelected] = useState<string[]>([]);
  const [askInputValue, setAskInputValue] = useState('');

  // File autocomplete for @ mentions
  const fileAutocomplete = useFileAutocomplete(projectId);

  const { messages: chatMessages, isRunning, status, activeRunCount, availableCommands, pendingAsk, resolveAsk, sendMessage, cancel, conversationId: hookConversationId, resetConversation, loadConversation } = useRun(activeConversationId || undefined);

  // pendingAsk 变化时重置临时状态
  useEffect(() => {
    setAskMultiSelected([]);
    setAskInputValue('');
  }, [pendingAsk]);

  // 首屏预取 agent 命令（无需先发消息）；run 中实时推送会覆盖
  const { data: prefetchedCommands } = useAgentCommands(agentId);
  const effectiveCommands = availableCommands.length > 0 ? availableCommands : (prefetchedCommands ?? []);

  // Sync conversationId from hook back to state after a run completes
  useEffect(() => {
    if (!isRunning && hookConversationId && hookConversationId !== activeConversationId) {
      setActiveConversationId(hookConversationId);
    }
  }, [isRunning, hookConversationId, activeConversationId]);

  // Fetch available models
  const { data: models } = useModels(agentId);
  const availableModels = (models && models.length > 0 ? models : DEFAULT_MODELS).filter((m) => m.id !== 'default');

  // Fetch conversations for this project
  const { data: conversations } = useConversations(projectId);

  // Fetch detected agents
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const currentAgent = agents?.find((a) => a.id === agentId);
  const agentAvailable = currentAgent?.available === true;
  const noAgentsAvailable = !agentsLoading && (!agents || agents.filter((a) => a.available).length === 0);

  // Auto-scroll when pinned
  useEffect(() => {
    if (isPinned) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isPinned]);

  // Track scroll position to determine if pinned
  const handleScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsPinned(distanceFromBottom < 80);
  };

  const handleSend = async () => {
    if (!input.trim() || !agentAvailable || isRunning) return;

    // /import <path> 拦截：切章写入当前项目后发起 decompose run
    const importMatch = input.trim().match(/^\/import\s+(.+)$/);
    if (importMatch) {
      const sourcePath = importMatch[1].trim();
      try {
        const res = await fetch(`/api/projects/${projectId}/import-source`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error || '导入失败');
          return;
        }
        toast.success(`已切分为 ${data.chapterCount} 章，开始逆向拆书`);
      } catch {
        toast.error('导入失败');
        return;
      }
      setInput('');
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage: 'decompose',
        message: '对已导入的源文本进行逆向拆书',
        model: selectedModel !== 'default' ? selectedModel : undefined,
      });
      return;
    }

    sendMessage({
      projectId,
      agentId,
      skillId,
      stage,
      message: input.trim(),
      model: selectedModel !== 'default' ? selectedModel : undefined,
    });
    setInput('');
  };

  const handleRetry = async () => {
    // Try to use the retry API for failed runs
    const lastAssistantMsg = [...chatMessages].reverse().find((m) => m.role === 'assistant' && m.error);
    if (lastAssistantMsg?.error) {
      // Find the run ID from events (if available)
      const lastUserMsg = [...chatMessages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg) {
        sendMessage({
          projectId,
          agentId,
          skillId,
          stage,
          message: lastUserMsg.content,
          model: selectedModel !== 'default' ? selectedModel : undefined,
        });
      }
      return;
    }

    // Fallback: resend last user message
    const lastUserMsg = [...chatMessages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage,
        message: lastUserMsg.content,
        model: selectedModel !== 'default' ? selectedModel : undefined,
      });
    }
  };

  const localCommands: Command[] = [
    { name: '/concept', description: '进入概念阶段', source: 'app', action: () => { onStageChange?.('concept'); sendMessage({ projectId, agentId, skillId, stage: 'concept', message: '切换到概念阶段' }); } },
    { name: '/world', description: '进入世界观阶段', source: 'app', action: () => { onStageChange?.('world'); sendMessage({ projectId, agentId, skillId, stage: 'world', message: '切换到世界观阶段' }); } },
    { name: '/characters', description: '进入角色阶段', source: 'app', action: () => { onStageChange?.('characters'); sendMessage({ projectId, agentId, skillId, stage: 'characters', message: '切换到角色阶段' }); } },
    { name: '/outline', description: '进入大纲阶段', source: 'app', action: () => { onStageChange?.('outline'); sendMessage({ projectId, agentId, skillId, stage: 'outline', message: '切换到大纲阶段' }); } },
    { name: '/scenes', description: '进入场景阶段', source: 'app', action: () => { onStageChange?.('scenes'); sendMessage({ projectId, agentId, skillId, stage: 'scenes', message: '切换到场景阶段' }); } },
    { name: '/draft', description: '进入写作阶段', source: 'app', action: () => { onStageChange?.('drafting'); sendMessage({ projectId, agentId, skillId, stage: 'drafting', message: '切换到写作阶段' }); } },
    { name: '/revision', description: '进入修改阶段', source: 'app', action: () => { onStageChange?.('revision'); sendMessage({ projectId, agentId, skillId, stage: 'revision', message: '切换到修改阶段' }); } },
    { name: '/polish', description: '进入润色阶段', source: 'app', action: () => { onStageChange?.('polish'); sendMessage({ projectId, agentId, skillId, stage: 'polish', message: '切换到润色阶段' }); } },
    { name: '/new', description: '开始新对话', source: 'app', action: () => { setActiveConversationId(null); resetConversation(); } },
    { name: '/import', description: '导入源文本并逆向拆书（/import <文件或目录路径>）', source: 'app' },
    { name: '/enrich', description: '补全缺失的结构化数据（state/outline-meta/关系图，只增不覆盖）', source: 'app', action: () => { sendMessage({ projectId, agentId, skillId, stage: 'enrich', message: '扫描并补全缺失的结构化数据' }); } },
    { name: '/retry', description: '重试上一条消息', source: 'app', action: () => { const last = [...chatMessages].reverse().find(m => m.role === 'user'); if (last) sendMessage({ projectId, agentId, skillId, stage, message: last.content }); } },
  ];

  // Agent 端 slash command（omp 经 ACP available_commands_update 推送，无 action → 填入输入框发给 agent）
  const agentCommands: Command[] = effectiveCommands.map((c) => ({
    name: `/${c.name}`,
    description: c.description + (c.inputHint ? ` ${c.inputHint}` : ''),
    source: 'agent',
  }));

  // app 命令优先于同名 agent 命令
  const localNames = new Set(localCommands.map((c) => c.name));
  const commands: Command[] = [...localCommands, ...agentCommands.filter((c) => !localNames.has(c.name))];

  const filteredCommands = showCommands
    ? commands.filter((c) => c.name.startsWith(input.split(' ')[0].toLowerCase()))
    : [];

  useEffect(() => {
    setActiveCmdIndex(0);
  }, [showCommands, input]);

  const selectCommand = (cmd: Command) => {
    setShowCommands(false);
    if (cmd.action) {
      setInput('');
      cmd.action();
    } else {
      // agent 命令：填入输入框，让用户补参数后发送给 agent
      setInput(cmd.name + ' ');
      textareaRef.current?.focus();
    }
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    resetConversation();
  };

  const handleSelectConversation = (convId: string) => {
    setActiveConversationId(convId);
    loadConversation(convId);
  };

  // Find the runId from the last assistant message's events
  const lastError = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;
  const hasError = lastError?.role === 'assistant' && lastError.error;

  return (
    <div className={panel}>
      <div className={toolbar}>
        <select
          className={select}
          value={activeConversationId || ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val) {
              handleSelectConversation(val);
            } else {
              handleNewChat();
            }
          }}
          disabled={isRunning}
        >
          <option value="">新对话</option>
          {conversations?.map((conv) => (
            <option key={conv.id} value={conv.id}>
              {conv.stage ? `[${conv.stage}] ` : ''}{new Date(conv.createdAt).toLocaleString()}
            </option>
          ))}
        </select>

        <select
          className={select}
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          disabled={isRunning}
        >
          <option value="default">Default</option>
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        <button className={iconBtn} onClick={handleNewChat} disabled={isRunning} title="新对话">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {onAgentChange && agents && agents.filter((a) => a.available).length > 0 && (
          <select
            className={select}
            value={agentId}
            onChange={(e) => {
              onAgentChange(e.target.value);
              setSelectedModel('default');
            }}
            disabled={isRunning}
            title="选择 AI Agent"
          >
            {agents.filter((a) => a.available).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}

        {!onAgentChange && currentAgent && (
          <span className={agentBadge} title={`${currentAgent.name}${currentAgent.version ? ` v${currentAgent.version}` : ''}`}>
            {currentAgent.name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      <div className={messages} ref={messagesRef} onScroll={handleScroll}>
        {chatMessages.length === 0 && (
          <div className={emptyState}>
            <div>开始对话</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
              输入消息开始与 AI 助手协作创作
            </div>
          </div>
        )}
        {chatMessages.map((msg, i) => (
          <div key={i}>
            <AgentMessage
              role={msg.role}
              content={msg.content}
              events={msg.events}
              startedAt={msg.startedAt}
              endedAt={msg.endedAt}
              usage={msg.usage}
              error={msg.error}
              artifacts={msg.artifacts}
              onResend={msg.role === 'user' ? (content) => {
                setInput(content);
                textareaRef.current?.focus();
              } : undefined}
              onReply={msg.role === 'assistant' ? (content) => {
                const quote = content.split('\n').map((line) => `> ${line}`).join('\n');
                setInput(`Regarding:\n${quote}\n\n`);
                textareaRef.current?.focus();
              } : undefined}
            />
            {msg.revisionDiff && msg.revisionDiff.diff && (
              <RevisionDiffPanel
                targetFile={msg.revisionDiff.targetFile}
                diff={msg.revisionDiff.diff}
                addedLines={msg.revisionDiff.addedLines}
                removedLines={msg.revisionDiff.removedLines}
              />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {!isPinned && chatMessages.length > 0 && (
        <button className={jumpBtn} onClick={() => {
          setIsPinned(true);
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }}>
          回到底部
        </button>
      )}

      {isRunning && (
        <div className={statusStrip}>
          <span className={statusDot} />
          <span>{status || '运行中...'}</span>
          {activeRunCount > 1 && <span style={{ opacity: 0.7 }}>({activeRunCount} active)</span>}
        </div>
      )}

      {hasError && !isRunning && (
        <div style={{ padding: '0.5rem 1rem' }}>
          <button className={stopBtn} style={{ width: '100%', fontSize: '0.8rem' }} onClick={handleRetry}>
            重试
          </button>
        </div>
      )}

      {noAgentsAvailable && (
        <div className={agentWarning} data-testid="agent-warning">
          <span>未检测到 AI Agent。请安装 Claude Code、OpenCode 或 Oh My Pi (omp) 以使用对话功能。
            {!agentsLoading && agents && agents.length > 0 && (
              <>（已发现 {agents.map((a) => a.name).join(', ')}，但不可用）</>
            )}
          </span>
        </div>
      )}

      {currentAgent && !agentAvailable && !noAgentsAvailable && (
        <div className={agentWarning} data-testid="agent-unavailable">
          <span>Agent "{currentAgent.name}" 不可用，请检查是否已安装并可访问。</span>
        </div>
      )}

      {pendingAsk && (
        <div className={askBox} data-testid="ask-prompt">
          <div className={askMessage}>{pendingAsk.message}</div>
          {pendingAsk.kind === 'select' && pendingAsk.options && (
            <div className={askOptions}>
              {pendingAsk.options.map((opt) => (
                <button
                  key={opt}
                  className={askOptionBtn}
                  onClick={() => resolveAsk('accept', opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          {pendingAsk.kind === 'multiselect' && pendingAsk.optionsMulti && (
            <>
              <div className={askOptions}>
                {pendingAsk.optionsMulti.map((opt) => {
                  const checked = askMultiSelected.includes(opt);
                  return (
                    <label key={opt} className={askCheckbox}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setAskMultiSelected((prev) =>
                            checked ? prev.filter((o) => o !== opt) : [...prev, opt],
                          );
                        }}
                      />
                      <span>{opt}</span>
                    </label>
                  );
                })}
              </div>
              <div className={askActions}>
                <button
                  className={askSubmitBtn}
                  disabled={askMultiSelected.length === 0}
                  onClick={() => resolveAsk('accept', askMultiSelected)}
                >
                  确认
                </button>
              </div>
            </>
          )}
          {pendingAsk.kind === 'input' && (
            <>
              <input
                className={askInput}
                placeholder={pendingAsk.placeholder || '请输入...'}
                value={askInputValue}
                onChange={(e) => setAskInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && askInputValue.trim()) {
                    resolveAsk('accept', askInputValue.trim());
                  }
                }}
              />
              <div className={askActions}>
                <button
                  className={askSubmitBtn}
                  disabled={!askInputValue.trim()}
                  onClick={() => resolveAsk('accept', askInputValue.trim())}
                >
                  提交
                </button>
              </div>
            </>
          )}
          {pendingAsk.kind === 'confirm' && (
            <div className={askActions}>
              <button className={askSubmitBtn} onClick={() => resolveAsk('accept', true)}>
                是
              </button>
              <button className={askCancelBtn} onClick={() => resolveAsk('accept', false)}>
                否
              </button>
            </div>
          )}
        </div>
      )}

      <div className={inputArea} style={{ position: 'relative' }}>
        {showCommands && filteredCommands.length > 0 && (
          <div className={autocompleteDropdown}>
            {filteredCommands.map((cmd, i) => (
              <div
                key={cmd.name}
                className={autocompleteItem}
                data-active={i === activeCmdIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectCommand(cmd);
                }}
                onMouseEnter={() => setActiveCmdIndex(i)}
              >
                <span className={autocompleteCmd}>{cmd.name}</span>
                <span className={autocompleteDesc}>{cmd.description}</span>
                <span className={`${cmdBadge} ${cmd.source === 'agent' ? cmdBadgeAgent : cmdBadgeApp}`}>
                  {cmd.source === 'agent' ? 'agent' : 'app'}
                </span>
              </div>
            ))}
          </div>
        )}
        {fileAutocomplete.showSuggestions && fileAutocomplete.suggestions.length > 0 && (
          <div className={autocompleteDropdown}>
            {fileAutocomplete.suggestions.map((file, i) => (
              <div
                key={file}
                className={autocompleteItem}
                data-active={i === fileAutocomplete.selectedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const cursorPos = textareaRef.current?.selectionStart || input.length;
                  const result = fileAutocomplete.completeMention(input, cursorPos, file);
                  if (result) {
                    setInput(result.value);
                    setTimeout(() => {
                      if (textareaRef.current) {
                        textareaRef.current.selectionStart = result.cursorPos;
                        textareaRef.current.selectionEnd = result.cursorPos;
                      }
                    }, 0);
                  }
                }}
                onMouseEnter={() => fileAutocomplete.setSelectedIndex(i)}
              >
                <span className={autocompleteCmd}>@{file}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={textarea}
          rows={2}
          placeholder="输入消息，/ 查看命令，@ 引用文件..."
          value={input}
          onChange={(e) => {
            const val = e.target.value;
            setInput(val);
            setShowCommands(val.startsWith('/') && !val.includes(' '));
            // Check for @ mentions
            const cursorPos = e.target.selectionStart || val.length;
            fileAutocomplete.checkMention(val, cursorPos);
          }}
          onKeyDown={(e) => {
            // Skip when IME is composing
            if (e.nativeEvent.isComposing) return;

            // Handle file autocomplete
            if (fileAutocomplete.showSuggestions && fileAutocomplete.suggestions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                fileAutocomplete.setSelectedIndex((i) => (i + 1) % fileAutocomplete.suggestions.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                fileAutocomplete.setSelectedIndex((i) => (i - 1 + fileAutocomplete.suggestions.length) % fileAutocomplete.suggestions.length);
                return;
              }
              if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                const cursorPos = textareaRef.current?.selectionStart || input.length;
                const result = fileAutocomplete.completeMention(input, cursorPos, fileAutocomplete.suggestions[fileAutocomplete.selectedIndex]);
                if (result) {
                  setInput(result.value);
                  setTimeout(() => {
                    if (textareaRef.current) {
                      textareaRef.current.selectionStart = result.cursorPos;
                      textareaRef.current.selectionEnd = result.cursorPos;
                    }
                  }, 0);
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                fileAutocomplete.setShowSuggestions(false);
                return;
              }
            }

            if (showCommands && filteredCommands.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveCmdIndex((i) => (i + 1) % filteredCommands.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveCmdIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                selectCommand(filteredCommands[activeCmdIndex]);
                return;
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                setInput(filteredCommands[activeCmdIndex].name + ' ');
                setShowCommands(false);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setShowCommands(false);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button className={sendBtn} onClick={handleSend} disabled={!input.trim() || !agentAvailable} title="发送">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
        {isRunning && (
          <button className={stopBtn} onClick={cancel} title="停止">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
