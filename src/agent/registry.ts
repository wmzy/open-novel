import type { RuntimeAgentDef } from './types';

export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  fallbackBins: ['openclaude'],
  versionArgs: ['--version'],
  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
  ],
  buildArgs: (prompt, extraAllowedDirs = [], options = {}) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    const dirs = extraAllowedDirs.filter((d) => typeof d === 'string' && d.length > 0);
    if (dirs.length > 0) args.push('--add-dir', ...dirs);
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  },
  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
};

export const opencodeAgentDef: RuntimeAgentDef = {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode',
  versionArgs: ['--version'],
  fallbackModels: [{ id: 'default', label: 'Default' }],
  buildArgs: (prompt, extraAllowedDirs = []) => {
    const args = ['--prompt', prompt, '--non-interactive'];
    const dirs = extraAllowedDirs.filter((d) => typeof d === 'string' && d.length > 0);
    if (dirs.length > 0) args.push('--add-dir', ...dirs);
    return args;
  },
  streamFormat: 'json-event-stream',
  installUrl: 'https://github.com/opencode-ai/opencode',
};

export const ompAgentDef: RuntimeAgentDef = {
  id: 'omp',
  name: 'Oh My Pi',
  bin: 'omp',
  fallbackBins: ['oh-my-pi'],
  versionArgs: ['--version'],
  fallbackModels: [{ id: 'default', label: '默认（由 omp 配置）' }],
  buildArgs: (_prompt, _extraAllowedDirs = [], _options = {}) => {
    // omp 作为 ACP server 启动；prompt 通过 ACP 协议传递，不经 CLI/buildArgs。
    return ['acp'];
  },
  streamFormat: 'acp-json-rpc',
  usesAcp: true,
  installUrl: 'https://github.com/can1357/oh-my-pi',
  docsUrl: 'https://agentclientprotocol.com/',
};

export const AGENT_DEFS: RuntimeAgentDef[] = [
  claudeAgentDef,
  opencodeAgentDef,
  ompAgentDef,
];

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
