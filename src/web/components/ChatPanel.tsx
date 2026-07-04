import { useState, useRef, useEffect } from 'react';
import { useRun } from '@/web/hooks/useRun';
import { useModels } from '@/web/hooks/useModels';
import { useConversations } from '@/web/hooks/useConversations';
import { useAgents } from '@/web/hooks/useAgents';
import { useFileAutocomplete } from '@/web/hooks/useFileAutocomplete';
import AgentMessage from './AgentMessage';
import RevisionDiffPanel from './RevisionDiffPanel';
import {
  panel, toolbar, select, iconBtn, messages, statusStrip, statusDot,
  inputArea, textarea, sendBtn, stopBtn, jumpBtn, emptyState,
  agentWarning, agentBadge, autocompleteDropdown, autocompleteItem,
  autocompleteCmd, autocompleteDesc,
} from './ChatPanel.styles';

interface Command {
  name: string;
  description: string;
  action: () => void;
}

interface Props {
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  onStageChange?: (stage: string) => void;
}

const DEFAULT_MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
];

export default function ChatPanel({ projectId, agentId, skillId, stage, onStageChange }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [selectedModel, setSelectedModel] = useState('default');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeCmdIndex, setActiveCmdIndex] = useState(0);
  const [showCommands, setShowCommands] = useState(false);

  // File autocomplete for @ mentions
  const fileAutocomplete = useFileAutocomplete(projectId);

  const { messages: chatMessages, isRunning, status, activeRunCount, sendMessage, cancel, conversationId: hookConversationId, resetConversation, loadConversation } = useRun(activeConversationId || undefined);

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

  const handleSend = () => {
    if (!input.trim() || !agentAvailable || isRunning) return;
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

  const commands: Command[] = [
    { name: '/concept', description: '进入概念阶段', action: () => { onStageChange?.('concept'); sendMessage({ projectId, agentId, skillId, stage: 'concept', message: '切换到概念阶段' }); } },
    { name: '/outline', description: '进入大纲阶段', action: () => { onStageChange?.('outline'); sendMessage({ projectId, agentId, skillId, stage: 'outline', message: '切换到大纲阶段' }); } },
    { name: '/draft', description: '进入写作阶段', action: () => { onStageChange?.('drafting'); sendMessage({ projectId, agentId, skillId, stage: 'drafting', message: '切换到写作阶段' }); } },
    { name: '/revision', description: '进入修改阶段', action: () => { onStageChange?.('revision'); sendMessage({ projectId, agentId, skillId, stage: 'revision', message: '切换到修改阶段' }); } },
    { name: '/polish', description: '进入润色阶段', action: () => { onStageChange?.('polish'); sendMessage({ projectId, agentId, skillId, stage: 'polish', message: '切换到润色阶段' }); } },
    { name: '/new', description: '开始新对话', action: () => { setActiveConversationId(null); resetConversation(); } },
    { name: '/retry', description: '重试上一条消息', action: () => { const last = [...chatMessages].reverse().find(m => m.role === 'user'); if (last) sendMessage({ projectId, agentId, skillId, stage, message: last.content }); } },
  ];

  const filteredCommands = showCommands
    ? commands.filter((c) => c.name.startsWith(input.split(' ')[0].toLowerCase()))
    : [];

  useEffect(() => {
    setActiveCmdIndex(0);
  }, [showCommands, input]);

  const selectCommand = (cmd: Command) => {
    setInput('');
    setShowCommands(false);
    cmd.action();
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

        {currentAgent && (
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
          <span>未检测到 AI Agent。请安装 Claude Code 或 OpenCode 以使用对话功能。
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
