import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useRun } from '@/web/hooks/useRun';
import type { SendMessageParams } from '@/web/hooks/useRun';
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
  detectScoreStagnation,
  critiqueConverged,
  parseDeadlineInput,
  parseLatestScores,
  type DeepenToChatDetail,
} from '../../shared/deepen';
import { STAGES } from '../../shared/stages';
import {
  BATCH_MAX_CHAPTERS,
  parseBatchCommand,
  batchChapterMessage,
  batchProgress,
  isBatchActive,
  type BatchState,
} from '../../shared/batch';
import AgentMessage from './AgentMessage';
import RevisionDiffPanel from './RevisionDiffPanel';
import { css, cx } from '@linaria/core';
import {
  panel, toolbar, select, iconBtn, messages, statusStrip, statusDot,
  inputArea, textarea, sendBtn, stopBtn, jumpBtn, emptyState,
  emptyFlow, emptyFlowArrow, emptyChips, emptyChip,
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

/** 写作族子阶段：与后端 resolveStagePiModel 一致，回退 writing 的阶段默认模型。 */
const WRITING_FAMILY_STAGES = new Set(['drafting', 'revision', 'polish', 'decompose', 'enrich', 'retro']);

/** 解析当前阶段的默认模型（pi_stage_models JSON）；损坏数据静默回退 undefined（全局默认）。 */
function resolveStageDefaultModel(raw: string | undefined, stage: string | undefined): string | undefined {
  if (!raw || !stage) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const map = parsed as Record<string, unknown>;
  const asModel = (key: string): string | undefined => {
    const value = map[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  return asModel(stage) ?? (WRITING_FAMILY_STAGES.has(stage) ? asModel('writing') : undefined);
}

interface Props {
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  onStageChange?: (stage: string) => void;
  onAgentChange?: (agentId: string) => void;
}

/** 深化循环状态机（可 JSON 序列化——落 localStorage 供刷新后恢复）。 */
interface DeepenModeState {
  active: boolean;
  stage: string;
  deadline: number;
  round: number;
  consecutiveFailures: number;
  consecutiveNoImprovement: number;
  /** 收敛标记：最新 critique 无 P0/P1，随后的 revise 轮为冻结轮（P2 入 backlog，不改产出）。 */
  converged?: boolean;
  userHint?: string;
  latestScores?: string | null;
  customDimensions?: Record<string, string[]>;
  /** 可选预算上限（美元）：累计消耗达到即停，防无人值守循环烧穿额度。 */
  budget?: number;
  /** 累计消耗（美元，累加每轮 run 的 usage.costUsd）。 */
  totalCost: number;
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

/** 提问挂起期间的锁影响提示。 */
const askLockHint = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

/** 样章门提示条（sample-gate 409 后的引导操作） */
const gateBanner = css`
  margin: 0 1rem 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--haze-color-primary);
  border-radius: 8px;
  background: var(--haze-color-bg);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

const gateBannerActions = css`
  display: flex;
  gap: 0.5rem;
`;

const gateBtn = css`
  flex: 1;
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text);
  cursor: pointer;
  &:hover { background: var(--haze-color-bg); }
`;

const gateBtnPrimary = css`
  ${gateBtn};
  background: var(--haze-color-primary);
  border-color: var(--haze-color-primary);
  color: white;
  &:hover { opacity: 0.9; }
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
  // 阶段下拉本地覆盖：下拉切换后 PATCH 是异步的，prop 更新前发送消息须用新阶段，
  // 否则「刚切到样章就发消息」仍走旧阶段提示词。prop 变化（PATCH 成功回刷）时清除。
  const [stageOverride, setStageOverride] = useState<string | null>(null);
  useEffect(() => {
    setStageOverride(null);
  }, [stage]);
  const effectiveStage = stageOverride ?? stage;
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
  const [deepenMode, setDeepenMode] = useState<DeepenModeState | null>(null);
  // 深化循环持久化：循环由前端驱动（每轮 run 结束后续轮），刷新/崩溃会静默中断。
  // deepenMode 落 localStorage，重载后提示继续或放弃。
  const deepenKey = `open-novel:deepen:${projectId}`;
  const [pendingDeepenResume, setPendingDeepenResume] = useState<DeepenModeState | null>(() => {
    try {
      const raw = localStorage.getItem(deepenKey);
      if (raw) {
        const parsed = JSON.parse(raw) as DeepenModeState;
        if (parsed?.active) return parsed;
      }
    } catch { /* 损坏数据按无循环处理 */ }
    return null;
  });
  // 首次挂载跳过持久化 effect：挂载时 deepenMode 恒为 null，立即清除会把
  // 待恢复的循环状态抹掉（用户刷新两次即丢失恢复入口）。只有 deepenMode
  // 发生真实变化（启动循环/退出循环）才写/清 localStorage。
  const deepenPersistInitialized = useRef(false);
  useEffect(() => {
    if (!deepenPersistInitialized.current) {
      deepenPersistInitialized.current = true;
      return;
    }
    try {
      if (deepenMode?.active) localStorage.setItem(deepenKey, JSON.stringify(deepenMode));
      else localStorage.removeItem(deepenKey);
    } catch { /* 存储不可用不影响循环本身 */ }
  }, [deepenMode, deepenKey]);
  const [pluginDimensions, setPluginDimensions] = useState<Record<string, string[]> | undefined>(undefined);
  const [showDeepenDialog, setShowDeepenDialog] = useState(false);
  const [deepenDialogStage, setDeepenDialogStage] = useState('');
  const [deadlineInput, setDeadlineInput] = useState('06:00');
  const [deepenHint, setDeepenHint] = useState('');
  const [budgetInput, setBudgetInput] = useState('');
  const prevIsRunningRef = useRef(false);
  // 深化循环倒计时：活跃时每 30s 刷新一次剩余时间显示
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deepenMode?.active) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [deepenMode?.active]);

  // ===== 批量写作：每章都是真实 run，前端逐章驱动 =====
  // 状态事实源是服务端 .novel/batch.json；挂载时只回显、不自动续跑，
  // 由用户点击「继续」（与深化循环的 mount-replay 一致）。
  const [batch, setBatch] = useState<BatchState | null>(null);
  const batchRef = useRef<BatchState | null>(null);
  /** 本前端最近启动的章节号；null = 非本前端驱动（刷新后等待用户继续）。 */
  const batchChapterRef = useRef<number | null>(null);
  const batchStartInFlightRef = useRef(false);
  /** 创建批量 API 在途（防止快速双击产生两个 batch）。 */
  const batchStartRequestRef = useRef(false);
  const batchRetryCountRef = useRef(0);
  const batchRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (batchRetryTimerRef.current) clearTimeout(batchRetryTimerRef.current);
  }, []);
  useEffect(() => {
    batchRef.current = batch;
  }, [batch]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/batch`);
        if (!res.ok) return;
        const data = (await res.json()) as { batch?: BatchState | null };
        if (!cancelled && data.batch && isBatchActive(data.batch)) setBatch(data.batch);
      } catch { /* 无历史批量或网络不可用 */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  /** 剩余时间格式化：Xh Ym（不足 1 小时显示分钟）。 */
  const fmtRemaining = (ms: number): string => {
    if (ms <= 0) return '已到截止';
    const totalMin = Math.ceil(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}时${m}分` : `${m}分钟`;
  };

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

  const { messages: chatMessages, isRunning, status, contextSize, runtimeUsage, lastFinishedRun, activeRunCount, availableCommands, pendingAsk, resolveAsk, sendMessage, cancel, conversationId: hookConversationId, resetConversation, loadConversation } = useRun(activeConversationId || undefined);

  // 灵感注入：来自视图 💡 按钮 dispatch 的事件，直接 sendMessage（消息已组装好）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage: effectiveStage,
        message: detail.message,
      });
    };
    window.addEventListener(INSPIRE_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(INSPIRE_TO_CHAT_EVENT, handler);
  }, [sendMessage, projectId, agentId, skillId, effectiveStage]);

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

  // 阶段默认模型（pi_stage_models）：设置页按阶段配置，default 选项的文案/提示用。
  // 与 SettingsPage 共用 ['settings'] 缓存键，queryFn 形状保持一致。
  const { data: piSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      const data = await res.json();
      return data.settings as Record<string, string>;
    },
  });
  const stageDefaultModel = useMemo(
    () => resolveStageDefaultModel(piSettings?.pi_stage_models, effectiveStage),
    [piSettings, effectiveStage],
  );

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
    // 可选预算上限（美元）：空或非正数视为不设限
    const budgetRaw = parseFloat(budgetInput.trim());
    const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : undefined;

    // 创建里程碑快照：深化前的回滚点，用户审核后可 restore
    fetch(`/api/runs/projects/${projectId}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `deepen-${ds}-start` }),
    }).then((r) => r.json()).then((data) => {
      if (data?.hash) {
        toast.success(`已创建回滚点 deepen-${ds}-start`);
      } else {
        toast.error(data?.error || '深化回滚点创建失败，请手动「存版本」');
      }
    }).catch(() => {
      toast.error('深化回滚点创建失败，请手动「存版本」');
    });

    setDeepenMode({ active: true, stage: ds, deadline, round: 1, consecutiveFailures: 0, consecutiveNoImprovement: 0, converged: false, userHint: hint, customDimensions: pluginDimensions, budget, totalCost: 0 });
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
  }, [deadlineInput, deepenDialogStage, deepenHint, budgetInput, sendMessage, projectId, agentId, skillId, selectedModel, pluginDimensions]);

  /** 退出深化模式 */
  const exitDeepen = useCallback((reason: string) => {
    setDeepenMode((prev) => {
      if (prev?.active) toast.info(`深化循环结束：${reason}`);
      return null;
    });
  }, []);

  /** 深化循环续轮：推进下一轮（或按停止条件结束）。
   * 抽取为独立回调：既在 run 完成（isRunning true→false）时由 effect 调用，
   * 也供「恢复挂起循环且当前无 run 在途」时直接调用（刷新发生在两轮之间）。 */
  const advanceDeepen = useCallback((mode: DeepenModeState) => {
    const lastMsg = chatMessages[chatMessages.length - 1];
    const succeeded = !lastMsg?.error;
    const consecutiveFailures = succeeded ? 0 : mode.consecutiveFailures + 1;
    // 累加本轮消耗（usage.costUsd 由 run 的 usage 事件填充）
    const roundCost = lastMsg?.usage?.costUsd ?? 0;
    const totalCost = mode.totalCost + roundCost;

    // 停止条件 1：连续 2 轮失败
    if (consecutiveFailures >= 2) {
      exitDeepen('连续 2 轮失败，疑似额度耗尽');
      return;
    }

    // 停止条件 2：收敛冻结轮完成——上一轮 critique 无 P0/P1（仅 P2），
    // 随后的 revise 冻结轮（P2 入 backlog、不改产出）成功完成即结束循环
    if (mode.converged && !isCritiqueRound(mode.round) && succeeded) {
      exitDeepen('收敛：审查无 P0/P1 问题，产出已冻结（P2 已记入 backlog）');
      return;
    }

    // 饱和检测 + 时间检查是异步的（需 fetch deepen-critique.md）
    void (async () => {
      // 收敛判定（任何轮次都检查）：审查无 P0/P1（仅 P2）→ 下一轮 revise 为冻结轮。
      // 不再受 DEEPEN_MIN_ROUNDS 限制——审查报告客观无 P0/P1 就该收敛，不强制凑轮数。
      let consecutiveNoImprovement = mode.consecutiveNoImprovement;
      let critiqueConvergedNow = false;
      let critiqueContent = '';
      if (isCritiqueRound(mode.round)) {
        try {
          const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('deepen-critique.md')}`);
          if (res.ok) {
            const data = await res.json();
            critiqueContent = data.content || '';
            critiqueConvergedNow = critiqueConverged(critiqueContent);
          }
        } catch { /* 读文件失败不阻断 */ }
      }

      // 获取 deepen-log.md（评分轨迹展示 + 停滞检测共用一次读取）
      let logContent = '';
      try {
        const logRes = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('deepen-log.md')}`);
        if (logRes.ok) {
          const logData = await logRes.json();
          logContent = logData.content || '';
        }
      } catch { /* 读文件失败不阻断 */ }

      // 停止条件 3：改进验证饱和——仅在超过最低轮数后检查（防止早期偶然命中）。
      // 信号 = 审查报告标记串 或 最近两轮维度评分完全停滞（不依赖 agent 逐字写标记）。
      if (mode.round >= DEEPEN_MIN_ROUNDS && isCritiqueRound(mode.round)) {
        const saturated = detectNoImprovement(critiqueContent) || detectScoreStagnation(logContent);
        if (saturated) {
          consecutiveNoImprovement++;
        } else {
          consecutiveNoImprovement = 0;
        }
        // 连续 2 个 Critique 轮饱和 → 真正停滞
        if (consecutiveNoImprovement >= 2) {
          exitDeepen('改进验证：连续 2 轮审查无实质改进');
          return;
        }
      }

      // 获取最新评分轨迹用于状态条展示
      let latestScores = mode.latestScores;
      if (logContent) {
        latestScores = parseLatestScores(logContent);
      }

      // 停止条件 4：截止时间到
      if (Date.now() >= mode.deadline) {
        exitDeepen('截止时间到');
        return;
      }

      // 停止条件 5：预算上限（美元）——防止无人值守循环烧穿额度
      if (mode.budget != null && totalCost >= mode.budget) {
        exitDeepen(`达到预算上限 $${mode.budget.toFixed(2)}（累计 $${totalCost.toFixed(4)}）`);
        return;
      }

      // 继续下一轮（失败时重试当前轮，不跳过）
      const nextRound = succeeded ? mode.round + 1 : mode.round;
      // 停止条件 6：达到最大轮数（兜底防止无限循环）
      if (nextRound > DEEPEN_MAX_ROUNDS) {
        exitDeepen(`达到最大轮数（${DEEPEN_MAX_ROUNDS}）`);
        return;
      }
      // 收敛后（含冻结轮重试）的 revise 轮均按冻结轮发送：P2 入 backlog，禁止改产出
      const converged = mode.converged || critiqueConvergedNow;
      setDeepenMode({ ...mode, round: nextRound, consecutiveFailures, consecutiveNoImprovement, latestScores, converged, totalCost });
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage: mode.stage,
        message: buildDeepenMessage(mode.stage, nextRound, mode.userHint, mode.customDimensions, converged),
        autonomous: true,
        trimHistory: true,
        deepenRound: nextRound,
        model: selectedModel !== 'default' ? selectedModel : undefined,
      });
    })();
  }, [chatMessages, exitDeepen, projectId, agentId, skillId, selectedModel, sendMessage]);

  // 深化循环续轮：run 完成后（isRunning true→false）触发下一轮
  useEffect(() => {
    if (!deepenMode?.active) {
      prevIsRunningRef.current = isRunning;
      return;
    }
    // 检测 isRunning 从 true→false（run 刚完成）
    if (prevIsRunningRef.current && !isRunning) {
      advanceDeepen(deepenMode);
    }
    prevIsRunningRef.current = isRunning;
  }, [isRunning, deepenMode, advanceDeepen]);

  // ===== 批量写作驱动 =====

  /** 调用批量 API（action='' 时为创建批量）。 */
  const batchApi = useCallback(async (
    action: string,
    body?: Record<string, unknown>,
  ): Promise<BatchState | null> => {
    const url = action
      ? `/api/projects/${projectId}/batch/${action}`
      : `/api/projects/${projectId}/batch`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      batch?: BatchState | null;
      message?: string;
      error?: string;
    };
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data.batch ?? null;
  }, [projectId]);

  /** 发起当前章的普通 run（POST /api/runs 由 useRun 完成）。 */
  const launchBatchChapter = useCallback((state: BatchState, resetRetry = false) => {
    if (state.status !== 'running' || batchStartInFlightRef.current) return;
    if (resetRetry) batchRetryCountRef.current = 0;
    batchStartInFlightRef.current = true;
    const chapter = state.currentChapter;
    batchChapterRef.current = chapter;
    sendMessage(
      {
        projectId,
        agentId,
        skillId,
        // 批量写作是正式写作；样章门照常由 POST /api/runs 校验。
        stage: 'writing',
        message: batchChapterMessage(chapter),
        model: selectedModel !== 'default' ? selectedModel : undefined,
      },
      {
        // 回填关联 runId：run 结束时服务端据此自动推进批量状态，
        // 即使浏览器被关闭/刷新，进度也不会停在已完成的章节。
        onRunStarted: (runId) => {
          void batchApi('run-started', { chapter, runId }).catch(() => {});
        },
      },
    );
  }, [sendMessage, batchApi, projectId, agentId, skillId, selectedModel]);

  /** 启动一批（N..M）。 */
  const handleStartBatch = useCallback(async (from: number, to: number) => {
    if (batchStartRequestRef.current) return;
    batchStartRequestRef.current = true;
    batchChapterRef.current = null;
    batchStartInFlightRef.current = false;
    try {
      const state = await batchApi('', { from, to, agentId, skillId });
      if (!state) return;
      setBatch(state);
      batchRef.current = state;
      launchBatchChapter(state, true);
    } catch (err) {
      toast.error(`批量写作启动失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      batchStartRequestRef.current = false;
    }
  }, [batchApi, launchBatchChapter, agentId, skillId]);

  /** 暂停：当前章继续写，结束后停在下一章。 */
  const handlePauseBatch = useCallback(async () => {
    try {
      const state = await batchApi('pause');
      if (state) {
        setBatch(state);
        toast.info(state.pauseRequested ? '当前章完成后暂停' : '批量写作已暂停');
      }
    } catch (err) {
      toast.error(`暂停失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [batchApi]);

  /** 继续：从暂停/失败处恢复并立即写下一章。 */
  const handleResumeBatch = useCallback(async () => {
    try {
      const state = await batchApi('resume');
      if (!state) return;
      setBatch(state);
      if (state.status === 'running') launchBatchChapter(state, true);
    } catch (err) {
      toast.error(`继续失败：${err instanceof Error ? err.message : String(err)}`);
      // 服务端可能已自动推进到 completed/canceled（例如刷新期间章节已结束）：
      // 重新拉取以更新横幅，而不是停留在过期的 running。
      try {
        const res = await fetch(`/api/projects/${projectId}/batch`);
        if (res.ok) {
          const data = (await res.json()) as { batch?: BatchState | null };
          if (data.batch) setBatch(data.batch);
        }
      } catch { /* ignore */ }
    }
  }, [batchApi, launchBatchChapter, projectId]);

  /** 取消：终止批量状态，并取消当前前端正在跟踪的 run。 */
  const handleCancelBatch = useCallback(async () => {
    if (batchRetryTimerRef.current) {
      clearTimeout(batchRetryTimerRef.current);
      batchRetryTimerRef.current = null;
    }
    batchStartInFlightRef.current = false;
    batchChapterRef.current = null;
    try {
      const state = await batchApi('cancel');
      if (state) setBatch(state);
    } catch { /* 状态更新失败也要停止当前 run */ }
    await cancel();
  }, [batchApi, cancel]);

  const prevBatchRunningRef = useRef(false);
  useEffect(() => {
    if (!batch || batch.status !== 'running') {
      prevBatchRunningRef.current = isRunning;
      return;
    }
    if (prevBatchRunningRef.current && !isRunning && batchChapterRef.current !== null) {
      const chapter = batchChapterRef.current;
      batchChapterRef.current = null;
      batchStartInFlightRef.current = false;
      const lastMsg = chatMessages[chatMessages.length - 1];

      // 里程碑回顾等其它真实 run 抢占了项目锁：不是本章失败，等它结束后重试本章。
      if (lastMsg?.errorCode === 'run-in-progress' && batchRetryCountRef.current < 120) {
        batchRetryCountRef.current += 1;
        if (batchRetryCountRef.current === 1) {
          toast.info('当前有其他任务在运行，批量写作等待其完成后继续…');
        }
        // 定时器挂在 ref 上：不随 effect 依赖变化被清理（run 收尾后仍可能有
        // 最后一次 delta flush 触发重渲染，若用 effect cleanup 会吞掉重试）。
        if (batchRetryTimerRef.current) clearTimeout(batchRetryTimerRef.current);
        batchRetryTimerRef.current = setTimeout(() => {
          batchRetryTimerRef.current = null;
          // 重新拉取服务端状态：等待期间当前章可能已被服务端自动推进/完成，
          // 不能拿本地过期状态直接启动下一章。
          void (async () => {
            try {
              const res = await fetch(`/api/projects/${projectId}/batch`);
              if (!res.ok) return;
              const data = (await res.json()) as { batch?: BatchState | null };
              const latest = data.batch ?? null;
              if (latest) {
                setBatch(latest);
                batchRef.current = latest;
              }
              // 用户可能在等待期间手动点了「继续」：已有在途章节时不要重复启动。
              if (
                latest?.status === 'running'
                && !batchStartInFlightRef.current
                && batchChapterRef.current === null
              ) {
                launchBatchChapter(latest);
              }
            } catch { /* 下个 run 结束后仍可手动继续 */ }
          })();
        }, 5000);
        prevBatchRunningRef.current = isRunning;
        return;
      }

      const succeeded = !lastMsg?.error && lastFinishedRun?.status === 'succeeded';
      void (async () => {
        try {
          const next = await batchApi('advance', {
            chapter,
            succeeded,
            reason: succeeded ? undefined : (lastMsg?.error || lastFinishedRun?.status || 'run failed'),
          });
          if (!next) return;
          setBatch(next);
          if (succeeded) {
            if (next.status === 'completed') {
              toast.success(`批量写作完成：第 ${next.from}-${next.to} 章全部结束`);
            }
          } else {
            toast.error(`第${chapter}章失败，批量已停止；点击「继续」将从该章重试`);
          }
          if (next.status === 'running') launchBatchChapter(next, true);
        } catch (err) {
          toast.error(`批量状态更新失败：${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
    prevBatchRunningRef.current = isRunning;
  }, [isRunning, batch, chatMessages, lastFinishedRun, batchApi, launchBatchChapter, projectId]);

  // Fetch conversations for this project
  const { data: conversations } = useConversations(projectId);

  // run 结束后失效审阅查询：run 进行中 GET /review 返回占位（后端不做 git/不
  // checkpoint 半成品），结束后重拉真实待审阅改动，审阅面板与徽标同步更新。
  const runWasActiveRef = useRef(false);
  useEffect(() => {
    if (runWasActiveRef.current && !isRunning) {
      queryClient.invalidateQueries({ queryKey: ['review', projectId] });
    }
    runWasActiveRef.current = isRunning;
  }, [isRunning, projectId, queryClient]);

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

  // 稳定回调：避免每次渲染创建新函数引用，使 AgentMessage memo 生效
  const handleResend = useCallback((content: string) => {
    setInput(content);
    textareaRef.current?.focus();
  }, []);

  const handleReply = useCallback((content: string) => {
    const quote = content.split('\n').map((line) => `> ${line}`).join('\n');
    setInput(`Regarding:\n${quote}\n\n`);
    textareaRef.current?.focus();
  }, []);

  const handleSend = async () => {
    if (!input.trim() || !agentAvailable || isRunning) return;

    // 批量写作命令：/batch 10-20、写第10到20章。整句匹配，避免误伤正文。
    const trimmed = input.trim();
    const batchRange = pendingRevise ? null : parseBatchCommand(trimmed);
    if (batchRange) {
      const count = batchRange.to - batchRange.from + 1;
      if (count > BATCH_MAX_CHAPTERS) {
        toast.error(`单批最多 ${BATCH_MAX_CHAPTERS} 章（本次 ${count} 章），请分批提交`);
        return;
      }
      if (batch && batch.status === 'running') {
        toast.error('已有批量写作进行中，请先暂停或取消');
        return;
      }
      if (deepenMode?.active) exitDeepen('用户启动批量写作');
      setInput('');
      await handleStartBatch(batchRange.from, batchRange.to);
      return;
    }

    // 批量写作未结束时阻止普通消息插队：会与章节 run 抢项目锁、污染上下文。
    if (batch && isBatchActive(batch)) {
      toast.warning('批量写作尚未结束：请先点击「继续」完成或「取消」后再发送其他消息');
      return;
    }

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
        const conflictNote = Array.isArray(data.conflicts) && data.conflicts.length > 0
          ? `（${data.conflicts.length} 章与已有章节冲突，原文件已备份为 .bak）`
          : '';
        toast.success(`已切分为 ${data.chapterCount} 章${conflictNote}，开始逆向拆书`);
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
      stage: effectiveStage,
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
    // 优先走重试端点：携带 interruptedResume（中断前已完成内容），
    // 让 agent 从异常中断位置继续，而不是盲发原文重写/跳过章节。
    const lastAssistantMsg = [...chatMessages].reverse().find((m) => m.role === 'assistant' && m.error);
    if (lastAssistantMsg?.runId) {
      try {
        const res = await fetch(`/api/runs/${lastAssistantMsg.runId}/retry`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          // 过期提问的暂存答案：回答时任务已超时，此处补回请求，让 agent 用上用户答案
          const lateAnswers = (data.lateAnswers ?? []) as Array<{ action: string; content?: { value?: unknown } }>;
          const lateText = lateAnswers
            .filter((a) => a.action === 'accept')
            .map((a) => {
              const v = a.content?.value;
              return Array.isArray(v) ? v.join('、') : String(v ?? '');
            })
            .filter((s) => s.length > 0)
            .join('；');
          sendMessage({
            projectId,
            agentId,
            skillId,
            stage: data.stage || effectiveStage,
            message: lateText
              ? `${data.message}\n\n[补充：此前提问的答案（回答时任务已结束，现补回）]\n${lateText}`
              : data.message,
            interruptedResume: data.interruptedResume,
            model: selectedModel !== 'default' ? selectedModel : undefined,
          });
          return;
        }
      } catch { /* 端点失败回退到原文重发 */ }
    }

    // Fallback: resend last user message
    const lastUserMsg = [...chatMessages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage: effectiveStage,
        message: lastUserMsg.content,
        model: selectedModel !== 'default' ? selectedModel : undefined,
      });
    }
  };

  /** 样章门被拦后「仍要继续」：按被拦截消息的原始意图（stage/mode）携带 force 重发。
   *  旧实现硬编码 stage:'writing'——用户在校样章阶段用「✎修订」被门拦时，
   *  唯一的逃生口却是「开始正式写作」，与用户意图错位。 */
  const handleForceWriting = () => {
    const lastUserMsg = [...chatMessages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    const blockedMsg = [...chatMessages].reverse().find((m) => m.role === 'assistant' && m.errorCode === 'sample-gate');
    const retryParams = (blockedMsg?.retryParams ?? null) as SendMessageParams | null;
    const isRevise = retryParams?.mode === 'revise' && !!retryParams.targetFile;
    toast(`跳过样章门${isRevise ? '继续本次修订' : '直接开始正式写作'}？`, {
      description: '样章用于检验声口与节奏，跳过后大纲问题会在正文中直接暴露',
      action: {
        label: `确认${isRevise ? '修订' : '开始'}`,
        onClick: () => {
          sendMessage({
            projectId,
            agentId,
            skillId,
            // 按原意图重发；刷新后 retryParams 丢失时回退当前阶段（而非硬编码 writing）
            stage: retryParams?.stage ?? effectiveStage,
            message: lastUserMsg.content,
            force: true,
            model: selectedModel !== 'default' ? selectedModel : undefined,
            ...(isRevise
              ? {
                  mode: 'revise' as const,
                  targetFile: retryParams!.targetFile,
                  revisionNote: retryParams!.revisionNote,
                }
              : {}),
          });
        },
      },
    });
  };

  const localCommands: Command[] = useMemo(() => [
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
    { name: '/batch', description: '批量写章（/batch 10-20，单批最多 10 章；也可直接说「写第10到20章」）', source: 'app' },
    { name: '/enrich', description: '补全缺失的结构化数据（state/outline-meta/关系图，只增不覆盖）', source: 'app', action: () => { sendMessage({ projectId, agentId, skillId, stage: 'enrich', message: '扫描并补全缺失的结构化数据' }); } },
    { name: '/retry', description: '重试上一条消息', source: 'app', action: () => { const last = [...chatMessages].reverse().find(m => m.role === 'user'); if (last) sendMessage({ projectId, agentId, skillId, stage: effectiveStage, message: last.content }); } },
    { name: '/explore', description: '自治推进当前阶段（不提问，AI 自主决策并落盘）', source: 'app', action: () => { sendMessage({ projectId, agentId, skillId, stage: effectiveStage, message: '自治推进当前阶段，所有创作决策自主做出', autonomous: true, model: selectedModel !== 'default' ? selectedModel : undefined }); } },
  ], [onStageChange, sendMessage, projectId, agentId, skillId, effectiveStage, resetConversation, chatMessages, selectedModel]);

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

  /** 空态起始提示：按当前阶段与技能类型给出可点击示例，点击填入输入框。 */
  const starterChips = useMemo(() => {
    const chips: Array<{ label: string; text: string }> = [];
    if (effectiveStage === 'concept') {
      if (skillId === 'wuxia') {
        chips.push({
          label: '写一部武侠小说',
          text: '我要写一部武侠小说，请先用采访式提问帮我确定故事的核心概念',
        });
      }
      chips.push({ label: '描述我的故事灵感', text: '我有一个故事灵感：' });
      chips.push({
        label: '引导我完成概念设计',
        text: '请用采访式提问帮我完成概念阶段的设计，从一句话梗概开始',
      });
    } else {
      chips.push({ label: '推进当前阶段', text: '请推进当前阶段' });
      chips.push({ label: '描述我的故事灵感', text: '我有一个故事灵感：' });
    }
    chips.push({ label: '查看全部命令', text: '/' });
    return chips;
  }, [effectiveStage, skillId]);

  /** 点击起始提示：填入输入框并聚焦；'/' 直接打开命令面板。 */
  const fillSuggestion = (text: string) => {
    setInput(text);
    setShowCommands(text.startsWith('/') && !text.includes(' '));
    setActiveCmdIndex(0);
    textareaRef.current?.focus();
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    resetConversation();
  };

  /** 删除当前会话：后端 DELETE /conversations/:id（含消息），文件产出不受影响。 */
  const handleDeleteConversation = async () => {
    const convId = activeConversationId;
    if (!convId) return;
    if (!window.confirm('删除当前会话及其全部消息？（章节与设定文件不受影响）')) return;
    try {
      const res = await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] });
      setActiveConversationId(null);
      resetConversation();
      toast.success('会话已删除');
    } catch {
      toast.error('删除会话失败');
    }
  };

  const handleSelectConversation = (convId: string) => {
    const conv = conversations?.find((c) => c.id === convId);
    if (conv?.stage && conv.stage !== stage) {
      toast.warning(`该会话创建于「${conv.stage}」阶段，切换后历史上下文将来自另一阶段`, {
        description: '如继续对话，早期问答可能混入当前阶段上下文',
      });
    }
    setActiveConversationId(convId);
    loadConversation(convId);
  };

  // Find the runId from the last assistant message's events
  const lastError = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;
  const hasError = lastError?.role === 'assistant' && !!lastError.error;
  const isSampleGate = lastError?.role === 'assistant' && lastError.errorCode === 'sample-gate';

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

        <button
          className={iconBtn}
          onClick={handleDeleteConversation}
          disabled={isRunning || !activeConversationId}
          title="删除当前会话（文件产出不受影响）"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>

        <select
          className={select}
          value={effectiveStage}
          onChange={(e) => {
            const v = e.target.value;
            setStageOverride(v);
            onStageChange?.(v);
          }}
          disabled={isRunning}
          title="当前创作阶段"
        >
          {STAGES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

        <select
          className={select}
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          disabled={isRunning}
          title={
            selectedModel === 'default'
              ? `默认模型：按当前阶段取设置中的阶段默认模型${stageDefaultModel ? `（当前阶段 → ${stageDefaultModel}）` : '；当前阶段未配置，使用全局默认'}`
              : '选择模型'
          }
        >
          <option value="default">默认（阶段模型{stageDefaultModel ? `：${stageDefaultModel}` : ''}）</option>
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
              描述你的故事灵感，AI 将带你逐阶段完成创作
            </div>
            <div className={emptyFlow}>
              {STAGES.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && <span className={emptyFlowArrow}> → </span>}
                  {s.label}
                </span>
              ))}
            </div>
            <div className={emptyChips}>
              {starterChips.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className={emptyChip}
                  disabled={isRunning}
                  onClick={() => fillSuggestion(chip.text)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {chatMessages.map((msg) => (
          <div key={msg.id}>
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
              onResend={msg.role === 'user' ? handleResend : undefined}
              onReply={msg.role === 'assistant' ? handleReply : undefined}
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

      {isSampleGate && !isRunning && (
        <div className={gateBanner}>
          <span>样章门未通过：正式写作前需完成 3 章样章（有效正文）并在 sample-feedback.md 提交 3 篇复盘。被拦截原因见上方错误提示。</span>
          <div className={gateBannerActions}>
            <button className={gateBtn} onClick={() => onStageChange?.('sample')}>
              去写样章
            </button>
            <button className={gateBtnPrimary} onClick={handleForceWriting}>
              仍要开始正式写作
            </button>
          </div>
        </div>
      )}

      {noAgentsAvailable && (
        <div className={agentWarning} data-testid="agent-warning">
          <span>内置 Pi 尚未配置模型。请到「设置 → 内置 Pi 模型」填写 provider、模型与 API Key（订阅用户可填本地反代地址）。
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
            <label>
              预算上限（美元，可选）：
              <input
                type="text"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder="如 5（达到即停止循环）"
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
          <div className={askLockHint}>回答前，该项目的其他写操作处于锁定状态</div>
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
        {batch && isBatchActive(batch) && (
          <div className={deepenBanner} data-testid="batch-banner">
            <span>
              📚 批量写作 · 第 {batch.currentChapter} / {batch.to} 章
              {' · '}剩余 {batchProgress(batch).remaining} 章
              {batch.status === 'running' && batch.pauseRequested && ' · 当前章完成后暂停'}
              {batch.status === 'paused' && ' · 已暂停'}
              {batch.status === 'failed' && ` · 第 ${batch.resumeChapter ?? batch.currentChapter} 章失败`}
            </span>
            {batch.status === 'running' && !batch.pauseRequested && (
              <button className={deepenCancelBtn} onClick={handlePauseBatch}>暂停</button>
            )}
            {(batch.status === 'paused'
              || batch.status === 'failed'
              || (batch.status === 'running' && !isRunning && batchChapterRef.current === null)) && (
              <button className={deepenConfirmBtn} onClick={handleResumeBatch} disabled={isRunning}>
                继续
              </button>
            )}
            <button className={deepenCancelBtn} onClick={handleCancelBatch} title="取消批量写作">
              取消
            </button>
          </div>
        )}
        {deepenMode?.active && (
          <div className={deepenBanner}>
            <span>
              🔁 深化中 · 第 {deepenMode.round} 轮{isCritiqueRound(deepenMode.round) ? '（审查）' : '（修订）'} · 截止 {new Date(deepenMode.deadline).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              {' · '}剩余 {fmtRemaining(deepenMode.deadline - now)}
              {deepenMode.totalCost > 0 && <> · 累计 ${deepenMode.totalCost.toFixed(4)}</>}
            </span>
            {deepenMode.latestScores && (
              <span className={deepenScores}>📊 {deepenMode.latestScores}</span>
            )}
            <button className={reviseBannerClose} onClick={() => exitDeepen('手动停止')} title="停止深化循环">✕</button>
          </div>
        )}
        {pendingDeepenResume && !deepenMode && (
          <div className={deepenBanner}>
            <span>
              ⏸ 检测到未完成的深化循环（{pendingDeepenResume.stage} 阶段 · 第 {pendingDeepenResume.round} 轮 · 截止 {new Date(pendingDeepenResume.deadline).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）
            </span>
            <button
              className={deepenConfirmBtn}
              onClick={() => {
                const mode = pendingDeepenResume;
                setPendingDeepenResume(null);
                setDeepenMode(mode);
                // 无 run 在途（刷新发生在两轮之间）：直接推进下一轮，
                // 否则等待当前 run 结束后由续轮 effect 接管。
                if (!isRunning) advanceDeepen(mode);
              }}
            >
              继续深化
            </button>
            <button
              className={deepenCancelBtn}
              onClick={() => {
                setPendingDeepenResume(null);
                // 显式放弃：清除持久化状态（挂载 effect 不代劳，避免误清）
                try { localStorage.removeItem(deepenKey); } catch { /* ignore */ }
              }}
            >
              放弃
            </button>
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
        <button className={sendBtn} onClick={handleSend} disabled={!input.trim() || !agentAvailable || isRunning} title="发送">
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
