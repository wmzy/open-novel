import { useState, useRef, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useRun } from '@/web/hooks/useRun';
import { useModels, useModelSelection } from '@/web/hooks/useModels';
import { useConversations } from '@/web/hooks/useConversations';
import { useAgents } from '@/web/hooks/useAgents';
import { useAgentCommands } from '@/web/hooks/useAgentCommands';
import { useFileAutocomplete } from '@/web/hooks/useFileAutocomplete';
import { REVISE_TO_CHAT_EVENT } from '@/web/hooks/useFileRevision';
import { INSPIRE_TO_CHAT_EVENT } from './InspirationPicker';
import {
  DEEPEN_TO_CHAT_EVENT,
  DEEPEN_MIN_ROUNDS,
  DEEPEN_MAX_ROUNDS,
  isCritiqueRound,
  buildDeepenMessage,
  detectNoImprovement,
  parseDeadlineInput,
  parseLatestScores,
  type DeepenToChatDetail,
} from '../../shared/deepen';
import AgentMessage from './AgentMessage';
import RevisionDiffPanel from './RevisionDiffPanel';
import { css, cx } from '@linaria/core';
import {
  panel, toolbar, select, iconBtn, messages, statusStrip, statusDot,
  inputArea, textarea, sendBtn, stopBtn, jumpBtn, emptyState,
  agentWarning, agentBadge, autocompleteDropdown, autocompleteItem,
  autocompleteCmd, autocompleteDesc, cmdBadge, cmdBadgeApp, cmdBadgeAgent,
  askBox, askMessage, askOptions, askOptionBtn, askCheckbox, askInput,
  askActions, askSubmitBtn, askCancelBtn,
  reviseBanner, reviseBannerClose,
  deepenOverlay, deepenDialog, deepenInput, deepenActions,
  deepenConfirmBtn, deepenCancelBtn, deepenBanner,
  deepenScores, deepenHintLabel, deepenHintInput,
  planToggle, planToggleActive,
  ctxBar, ctxBarTrack, ctxBarFill, ctxBarWarn,
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

/** 按 projectId 持久化当前会话 id，刷新后恢复上次会话内容。 */
const convKey = (pid: string) => `open-novel:active-conversation:${pid}`;
function readStoredConvId(pid: string): string | null {
  try { return localStorage.getItem(convKey(pid)); } catch { return null; }
}
function writeStoredConvId(pid: string, id: string | null) {
  try {
    if (id) localStorage.setItem(convKey(pid), id);
    else localStorage.removeItem(convKey(pid));
  } catch { /* ignore */ }
}

const DEFAULT_MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
];

/** 空状态提示文字 */
const emptyHint = css`
  font-size: 0.75rem;
  opacity: 0.7;
`;

/** 格式化 token 数为可读字符串（1.2k / 850） */
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 活跃运行数标记 */
const activeCount = css`
  opacity: 0.7;
`;

/** 错误重试包裹 */
const errorRetryWrap = css`
  padding: 0.5rem 1rem;
`;

/** 重试按钮全宽 */
const retryBtnFull = css`
  width: 100%;
  font-size: 0.8rem;
`;

export default function ChatPanel({ projectId, agentId, skillId, stage, onStageChange, onAgentChange }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => readStoredConvId(projectId));
  const [activeCmdIndex, setActiveCmdIndex] = useState(0);
  const [showCommands, setShowCommands] = useState(false);

  // ask 选择框临时状态（多选的已选项、输入的文本）
  const [askMultiSelected, setAskMultiSelected] = useState<string[]>([]);
  const [askInputValue, setAskInputValue] = useState('');

  // 修订模式：来自视图/卡片 ✎ dispatch 的 revise-to-chat 事件，发送时附加 mode/targetFile/revisionNote
  const [pendingRevise, setPendingRevise] = useState<
    { targetFile: string; sectionTitle?: string } | null
  >(null);
  // Plan Mode（规划模式）：开启后发送的 run 携带 planMode=true，先分析规划不直接改文件
  const [planMode, setPlanMode] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { targetFile: string; sectionTitle?: string };
      setPendingRevise(detail);
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    window.addEventListener(REVISE_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(REVISE_TO_CHAT_EVENT, handler);
  }, []);

  // 深化模式状态机：来自视图 🔁 按钮 dispatch 的事件，弹出截止时间输入，进入循环
  const [deepenMode, setDeepenMode] = useState<{
    active: boolean;
    stage: string;
    deadline: number;
    round: number;
    consecutiveFailures: number;
    consecutiveNoImprovement: number;
    userHint?: string;
    latestScores?: string | null;
    customDimensions?: Record<string, string[]>;
  } | null>(null);
  const [pluginDimensions, setPluginDimensions] = useState<Record<string, string[]> | undefined>(undefined);
  const [showDeepenDialog, setShowDeepenDialog] = useState(false);
  const [deepenDialogStage, setDeepenDialogStage] = useState('');
  const [deadlineInput, setDeadlineInput] = useState('06:00');
  const [deepenHint, setDeepenHint] = useState('');
  const prevIsRunningRef = useRef(false);

  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as DeepenToChatDetail;
      setDeepenDialogStage(detail.stage);
      // 预取 plugin 自定义维度（如有）
      try {
        const res = await fetch(`/api/plugins/${skillId}`);
        if (res.ok) {
          const data = await res.json();
          setPluginDimensions(data.manifest?.dimensions || undefined);
        }
      } catch { /* fallback 到通用维度 */ }
      setShowDeepenDialog(true);
    };
    window.addEventListener(DEEPEN_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(DEEPEN_TO_CHAT_EVENT, handler);
  }, [skillId]);

  // File autocomplete for @ mentions
  const fileAutocomplete = useFileAutocomplete(projectId);
  const queryClient = useQueryClient();

  const { messages: chatMessages, isRunning, status, contextSize, runtimeUsage, activeRunCount, availableCommands, pendingAsk, resolveAsk, sendMessage, cancel, conversationId: hookConversationId, resetConversation, loadConversation } = useRun(activeConversationId || undefined);

  // 灵感注入：来自视图 💡 按钮 dispatch 的事件，直接 sendMessage（消息已组装好）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage,
        message: detail.message,
      });
    };
    window.addEventListener(INSPIRE_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(INSPIRE_TO_CHAT_EVENT, handler);
  }, [sendMessage, projectId, agentId, skillId, stage]);

  // pendingAsk 变化时重置临时状态
  useEffect(() => {
    setAskMultiSelected([]);
    setAskInputValue('');
  }, [pendingAsk]);

  // 首屏预取 agent 命令（无需先发消息）；run 中实时推送会覆盖
  const { data: prefetchedCommands } = useAgentCommands(agentId);
  const effectiveCommands = availableCommands.length > 0 ? availableCommands : (prefetchedCommands ?? []);

  // Sync conversationId from hook back to state after a run completes.
  // hookConversationId 来自 ref，不放入依赖数组（按值比较即可，避免渲染循环）。
  useEffect(() => {
    if (!isRunning && hookConversationId && hookConversationId !== activeConversationId) {
      setActiveConversationId(hookConversationId);
      // 新会话刚被后端创建，列表缓存尚未包含 → 刷新会话列表，
      // 否则下方的存在性校验 effect 会把它当成不存在的会话清空，两者互相覆写形成死循环。
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, activeConversationId]);

  // 持久化 activeConversationId（变更即写入）
  useEffect(() => {
    writeStoredConvId(projectId, activeConversationId);
  }, [projectId, activeConversationId]);

  // Fetch available models
  const { data: models } = useModels(agentId);
  const availableModels = (models && models.length > 0 ? models : DEFAULT_MODELS).filter((m) => m.id !== 'default');

  // 模型选择持久化到 localStorage（跨刷新/重进记住），切 agent 后旧模型不在新列表则自动回退 default
  const [selectedModel, setSelectedModel] = useModelSelection(availableModels.map((m) => m.id));

  /** 启动深化循环：从第 1 轮开始 */
  const startDeepen = useCallback(() => {
    // 并发保护：已有活跃深化循环时拒绝启动新循环
    if (deepenMode?.active) {
      toast.error('已有深化循环进行中，请先停止当前循环');
      setShowDeepenDialog(false);
      return;
    }
    const deadline = parseDeadlineInput(deadlineInput);
    if (!deadline) {
      toast.error('截止时间格式无效，请用 HH:MM 格式');
      return;
    }
    const ds = deepenDialogStage;
    const hint = deepenHint.trim() || undefined;

    // 创建里程碑快照：深化前的回滚点，用户审核后可 restore
    fetch(`/api/projects/${projectId}/snapshots/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `deepen-${ds}-start` }),
    }).then((r) => r.ok ? r.json() : null).then((data) => {
      if (data?.hash) toast.success(`已创建回滚点 deepen-${ds}-start`);
    }).catch(() => {});

    setDeepenMode({ active: true, stage: ds, deadline, round: 1, consecutiveFailures: 0, consecutiveNoImprovement: 0, userHint: hint, customDimensions: pluginDimensions });
    setShowDeepenDialog(false);
    sendMessage({
      projectId,
      agentId,
      skillId,
      stage: ds,
      message: buildDeepenMessage(ds, 1, hint, pluginDimensions),
      autonomous: true,
      trimHistory: true,
      deepenRound: 1,
      model: selectedModel !== 'default' ? selectedModel : undefined,
    });
  }, [deadlineInput, deepenDialogStage, deepenHint, sendMessage, projectId, agentId, skillId, selectedModel, pluginDimensions]);

  /** 退出深化模式 */
  const exitDeepen = useCallback((reason: string) => {
    setDeepenMode((prev) => {
      if (prev?.active) toast.info(`深化循环结束：${reason}`);
      return null;
    });
  }, []);

  // 深化循环续轮：run 完成后（isRunning true→false）触发下一轮
  useEffect(() => {
    if (!deepenMode?.active) {
      prevIsRunningRef.current = isRunning;
      return;
    }
    // 检测 isRunning 从 true→false（run 刚完成）
    if (prevIsRunningRef.current && !isRunning) {
      const lastMsg = chatMessages[chatMessages.length - 1];
      const succeeded = !lastMsg?.error;
      const consecutiveFailures = succeeded ? 0 : deepenMode.consecutiveFailures + 1;

      // 停止条件 1：连续 2 轮失败
      if (consecutiveFailures >= 2) {
        exitDeepen('连续 2 轮失败，疑似额度耗尽');
        prevIsRunningRef.current = isRunning;
        return;
      }

      // 饱和检测 + 时间检查是异步的（需 fetch deepen-critique.md）
      (async () => {
        // 停止条件 2：改进验证饱和——仅在超过最低轮数后，且当前刚完成 Critique 轮时检查
        let consecutiveNoImprovement = deepenMode.consecutiveNoImprovement;
        if (deepenMode.round >= DEEPEN_MIN_ROUNDS && isCritiqueRound(deepenMode.round)) {
          try {
            const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('deepen-critique.md')}`);
            if (res.ok) {
              const data = await res.json();
              if (detectNoImprovement(data.content || '')) {
                consecutiveNoImprovement++;
              } else {
                consecutiveNoImprovement = 0;
              }
              // 连续 2 个 Critique 轮报告无实质改进 → 真正饱和
              if (consecutiveNoImprovement >= 2) {
                exitDeepen('改进验证：连续 2 轮审查无实质改进');
                prevIsRunningRef.current = isRunning;
                return;
              }
            }
          } catch { /* 读文件失败不阻断 */ }
        }

        // 获取最新评分轨迹用于状态条展示
        let latestScores = deepenMode.latestScores;
        try {
          const logRes = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('deepen-log.md')}`);
          if (logRes.ok) {
            const logData = await logRes.json();
            latestScores = parseLatestScores(logData.content || '');
          }
        } catch { /* 读文件失败不阻断 */ }

        // 停止条件 3：截止时间到
        if (Date.now() >= deepenMode.deadline) {
          exitDeepen('截止时间到');
          prevIsRunningRef.current = isRunning;
          return;
        }

        // 继续下一轮（失败时重试当前轮，不跳过）
        const nextRound = succeeded ? deepenMode.round + 1 : deepenMode.round;
        // 停止条件 4：达到最大轮数（兜底防止无限循环）
        if (nextRound > DEEPEN_MAX_ROUNDS) {
          exitDeepen(`达到最大轮数（${DEEPEN_MAX_ROUNDS}）`);
          prevIsRunningRef.current = isRunning;
          return;
        }
        setDeepenMode({ ...deepenMode, round: nextRound, consecutiveFailures, consecutiveNoImprovement, latestScores });
        sendMessage({
          projectId,
          agentId,
          skillId,
          stage: deepenMode.stage,
          message: buildDeepenMessage(deepenMode.stage, nextRound, deepenMode.userHint, deepenMode.customDimensions),
          autonomous: true,
          trimHistory: true,
          deepenRound: nextRound,
          model: selectedModel !== 'default' ? selectedModel : undefined,
        });
      })();
    }
    prevIsRunningRef.current = isRunning;
  }, [isRunning, deepenMode, chatMessages, exitDeepen, projectId, agentId, skillId, selectedModel, sendMessage]);

  // Fetch conversations for this project
  const { data: conversations } = useConversations(projectId);

  // 校验恢复的会话 id 仍存在；已被删除则回退到最新会话或清空
  useEffect(() => {
    if (!conversations || activeConversationId === null) return;
    // hook 持有的会话 id 是刚创建/加载的真实会话，列表可能尚未刷新包含它。
    // 跳过校验，避免与 sync effect 互相覆写 activeConversationId 造成死循环。
    if (activeConversationId === hookConversationId) return;
    const stillExists = conversations.some((c) => c.id === activeConversationId);
    if (!stillExists) {
      setActiveConversationId(conversations[0]?.id ?? null);
    }
  }, [conversations, activeConversationId, hookConversationId]);

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

    // 用户手动发消息 → 退出深化模式
    if (deepenMode?.active) exitDeepen('用户手动中断');

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
      planMode,
      ...(pendingRevise
        ? {
            mode: 'revise' as const,
            targetFile: pendingRevise.targetFile,
            revisionNote: pendingRevise.sectionTitle
              ? `【定向修订：仅修改「${pendingRevise.sectionTitle}」这一节】\n${input.trim()}`
              : input.trim(),
          }
        : {}),
    });
    setInput('');
    setPendingRevise(null);
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
    { name: '/new', description: '开始新对话', source: 'app', action: () => { setActiveConversationId(null); resetConversation(); setPendingRevise(null); } },
    { name: '/import', description: '导入源文本并逆向拆书（/import <文件或目录路径>）', source: 'app' },
    { name: '/enrich', description: '补全缺失的结构化数据（state/outline-meta/关系图，只增不覆盖）', source: 'app', action: () => { sendMessage({ projectId, agentId, skillId, stage: 'enrich', message: '扫描并补全缺失的结构化数据' }); } },
    { name: '/retry', description: '重试上一条消息', source: 'app', action: () => { const last = [...chatMessages].reverse().find(m => m.role === 'user'); if (last) sendMessage({ projectId, agentId, skillId, stage, message: last.content }); } },
    { name: '/explore', description: '自治推进当前阶段（不提问，AI 自主决策并落盘）', source: 'app', action: () => { sendMessage({ projectId, agentId, skillId, stage, message: '自治推进当前阶段，所有创作决策自主做出', autonomous: true, model: selectedModel !== 'default' ? selectedModel : undefined }); } },
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
            <div className={emptyHint}>
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
              contextSize={msg.contextSize}
              error={msg.error}
              artifacts={msg.artifacts}
              projectId={projectId}
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
          {!runtimeUsage && contextSize && (
            <span className={activeCount}>Ctx {fmtTok(contextSize.tokens)} tok · {(contextSize.chars / 1000).toFixed(1)}k chars</span>
          )}
          {activeRunCount > 1 && <span className={activeCount}>({activeRunCount} active)</span>}
        </div>
      )}

      {hasError && !isRunning && (
        <div className={errorRetryWrap}>
          <button className={cx(stopBtn, retryBtnFull)} onClick={handleRetry}>
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

      {showDeepenDialog && (
        <div className={deepenOverlay}>
          <div className={deepenDialog}>
            <span>🔁 深化「{deepenDialogStage}」阶段</span>
            <label>
              截止时间：
              <input
                type="text"
                value={deadlineInput}
                onChange={(e) => setDeadlineInput(e.target.value)}
                placeholder="HH:MM"
                className={deepenInput}
              />
            </label>
            <label className={deepenHintLabel}>
              特别指导（可选）：
              <textarea
                value={deepenHint}
                onChange={(e) => setDeepenHint(e.target.value)}
                placeholder="如：增加更多女性角色 / 加强反派的动机深度 / 补充角色间的暧昧关系..."
                className={deepenHintInput}
                rows={3}
              />
            </label>
            <div className={deepenActions}>
              <button onClick={startDeepen} className={deepenConfirmBtn}>开始</button>
              <button onClick={() => setShowDeepenDialog(false)} className={deepenCancelBtn}>取消</button>
            </div>
          </div>
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

      {runtimeUsage && (
        <div className={ctxBar}>
          <span>
            {fmtTok(runtimeUsage.used)} tok
            {runtimeUsage.size > 0 && ` / ${fmtTok(runtimeUsage.size)} tok`}
          </span>
          {runtimeUsage.size > 0 && (
            <>
              <div className={ctxBarTrack}>
                <div
                  className={cx(ctxBarFill, runtimeUsage.used / runtimeUsage.size > 0.8 && ctxBarWarn)}
                  style={{ width: `${Math.min(100, (runtimeUsage.used / runtimeUsage.size) * 100)}%` }}
                />
              </div>
              <span>{Math.round((runtimeUsage.used / runtimeUsage.size) * 100)}%</span>
            </>
          )}
          {runtimeUsage.costUsd != null && runtimeUsage.costUsd > 0 && (
            <span>${runtimeUsage.costUsd.toFixed(4)}</span>
          )}
        </div>
      )}

      <div className={inputArea}>
        {pendingRevise && (
          <div className={reviseBanner}>
            <span>📌 正在修订 {pendingRevise.targetFile}{pendingRevise.sectionTitle ? ` · ${pendingRevise.sectionTitle}` : ''}</span>
            <button className={reviseBannerClose} onClick={() => setPendingRevise(null)} title="退出修订模式">✕</button>
          </div>
        )}
        {deepenMode?.active && (
          <div className={deepenBanner}>
            <span>
              🔁 深化中 · 第 {deepenMode.round} 轮{isCritiqueRound(deepenMode.round) ? '（审查）' : '（修订）'} · 截止 {new Date(deepenMode.deadline).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {deepenMode.latestScores && (
              <span className={deepenScores}>📊 {deepenMode.latestScores}</span>
            )}
            <button className={reviseBannerClose} onClick={() => exitDeepen('手动停止')} title="停止深化循环">✕</button>
          </div>
        )}
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
        <button
          className={cx(planToggle, planMode && planToggleActive)}
          onClick={() => setPlanMode((v) => !v)}
          title="Plan Mode：先分析规划再执行，不直接修改文件"
          aria-pressed={planMode}
        >
          📋 规划
        </button>
        <textarea
          ref={textareaRef}
          className={textarea}
          rows={2}
          placeholder={pendingRevise ? `输入对 ${pendingRevise.targetFile} 的修订意见...` : '输入消息，/ 查看命令，@ 引用文件...'}
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
