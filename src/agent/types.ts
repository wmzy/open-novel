export type RuntimeModelOption = { id: string; label: string };

/** /api/agents 返回的内置 Agent 描述（仅 Pi）。 */
export type DetectedAgent = {
  id: string;
  name: string;
  models: RuntimeModelOption[];
  available: boolean;
  streamFormat?: string;
  version?: string | null;
  error?: string;
};

/** Events emitted by the stream parser */
export type StreamEvent =
  | { type: 'status'; label: string; model?: string | null; detail?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'usage'; usage?: unknown; costUsd?: number | null }
  | { type: 'context_size'; chars: number; tokens: number }
  | { type: 'runtime_usage'; used: number; size: number; costUsd?: number | null; model?: string | null }
  | { type: 'cost_alert'; spentUsd: number; budgetUsd: number; percent: number; runCostUsd: number }
  | { type: 'error'; message: string }
  | { type: 'commands'; commands: AgentCommand[] }
  | { type: 'ask'; ask: AskPrompt }
  | { type: 'raw'; line: string };

/** Agent slash command (simplified from ACP AvailableCommand) */
export type AgentCommand = {
  name: string;
  description: string;
  inputHint?: string;
};

/**
 * 向用户提问的选择框。
 *
 * 内置 Pi 的 `ask` 自定义工具把问题转成此结构，经 SSE 推给前端；
 * 前端渲染选择题/输入框，用户回答后经 /api/runs/:id/ask/:askId 回传。
 * 字段保留 select/confirm/input/multiselect 以兼容旧事件。
 */
export type AskPrompt = {
  /** 唯一 id，前端回传时带上以匹配 pending promise。 */
  askId: string;
  /** 提问语义。 */
  kind: 'select' | 'confirm' | 'input' | 'multiselect';
  /** agent 的问题文本。 */
  message: string;
  /** 单选选项（kind='select' 时）。 */
  options?: string[];
  /** 多选选项（kind='multiselect' 时）。 */
  optionsMulti?: string[];
  /** 文本输入提示（kind='input' 时）。 */
  placeholder?: string;
  /** 旧外部 Agent 的 AskUserQuestion 工具调用 id（兼容字段；内置 Pi 不使用）。 */
  toolUseId?: string;
};

/** Persisted agent events on messages (used by frontend) */
export type AgentEvent =
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: 'ask'; ask: AskPrompt }
  | { kind: 'raw'; line: string };
