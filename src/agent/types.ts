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
  | { type: 'error'; message: string }
  | { type: 'commands'; commands: AgentCommand[] }
  | { type: 'raw'; line: string };

/** Agent slash command (simplified from ACP AvailableCommand) */
export type AgentCommand = {
  name: string;
  description: string;
  inputHint?: string;
};

/** Persisted agent events on messages (used by frontend) */
export type AgentEvent =
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: 'raw'; line: string };
