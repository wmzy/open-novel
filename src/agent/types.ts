export type RuntimeModelOption = { id: string; label: string };

export type RuntimeBuildOptions = {
  model?: string | null;
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
  | { type: 'raw'; line: string };

/** Persisted agent events on messages (used by frontend) */
export type AgentEvent =
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: 'raw'; line: string };
