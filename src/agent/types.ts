export type RuntimeModelOption = { id: string; label: string };

export type RuntimeBuildOptions = {
  model?: string | null;
  /** 用于 ACP 协议：prompt 由调用方经协议传，launchAgent 不 write。 */
  promptDeferred?: boolean;
};

export type RuntimeAgentDef = {
  id: string;
  name: string;
  bin: string;
  versionArgs: string[];
  fallbackModels: RuntimeModelOption[];
  buildArgs: (prompt: string, extraAllowedDirs?: string[], options?: RuntimeBuildOptions) => string[];
  streamFormat: string;
  fallbackBins?: string[];
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  /** ACP 协议：stdin/stdout 双向 JSON-RPC，prompt 由 runAcpTurn 经协议发。 */
  usesAcp?: boolean;
  installUrl?: string;
  docsUrl?: string;
};

export type DetectedAgent = Omit<RuntimeAgentDef, 'buildArgs' | 'fallbackModels' | 'fallbackBins'> & {
  models: RuntimeModelOption[];
  available: boolean;
  path?: string;
  version?: string | null;
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
  | { type: 'runtime_usage'; used: number; size: number; costUsd?: number | null }
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
 * ACP elicitation（向用户提问的选择框）。
 *
 * omp skill 调 select/confirm/input 时，经 ACP elicitation/create 请求到 client。
 * open-novel 把它转成此结构经 SSE 推给前端，前端渲染选择框，用户答后回传。
 *
 * schema 取自 ACP ElicitationFormMode.requestedSchema.properties.value：
 * - type='string' + enum → 单选
 * - type='string' 无 enum → 文本输入
 * - type='boolean' → 确认（是/否）
 * - type='array' → 多选
 */
export type AskPrompt = {
  /** 唯一 id，前端回传时带上以匹配 pending promise。 */
  askId: string;
  /** omp 的 ask 语义（映射自 schema.type）。 */
  kind: 'select' | 'confirm' | 'input' | 'multiselect';
  /** agent 的问题文本。 */
  message: string;
  /** 单选选项（kind='select' 时）。 */
  options?: string[];
  /** 多选选项（kind='multiselect' 时）。 */
  optionsMulti?: string[];
  /** 文本输入提示（kind='input' 时）。 */
  placeholder?: string;
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
