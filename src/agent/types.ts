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

export type StreamEvent = {
  type: 'status' | 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'usage' | 'error' | 'raw';
  [key: string]: unknown;
};
