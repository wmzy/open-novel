/**
 * 内置 Pi SDK 运行时。
 *
 * 每个 run 创建一个内存 AgentSession，由 composePrompt() 提供完整任务上下文；
 * 事件统一映射为 open-novel 的 StreamEvent，供 RunStream/SSE/UI 复用。
 * 不启动外部 CLI 子进程。
 */
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { AskPrompt, StreamEvent } from '../types';
import { createOpenNovelApiTool, type OpenNovelApiToolOptions } from './api-tool';
import {
  createPiModelRuntime,
  piAgentDir,
  resolvePiModel,
  resolveStagePiModel,
  type PiSettings,
  type PiThinkingLevel,
} from './config';

const PI_SYSTEM_PROMPT = [
  '你是一个小说创作 Agent，在用户给定的项目目录内工作。',
  '严格遵循用户消息中的阶段指令、文件格式与输出协议。',
  '优先使用 read/write/edit/grep/find/ls 工具读写项目文件；不要访问项目目录之外的内容。',
  '不要输出与任务无关的解释；需要落盘的内容必须通过工具写入文件。',
].join('\n');

const DEFAULT_TOOLS = ['read', 'write', 'edit', 'grep', 'find', 'ls'];

/**
 * 把 open-novel 的「选择题提问」注册成 Pi 自定义工具。
 * 模型调用 ask 后，run 会挂起（registerAsk），前端渲染选择框；
 * 用户回答后工具返回 JSON，agent 继续。
 */
function createAskTool(
  onAsk: (ask: AskPrompt) => Promise<{ action: 'accept' | 'cancel'; content?: unknown }>,
) {
  return defineTool({
    name: 'ask',
    label: '提问',
    description:
      '向用户提出需要拍板的选择题。每个问题提供 2-5 个选项；' +
      '不要在正文里用 A/B/C 文字列表让用户打字回复，必须调用本工具。',
    promptSnippet: 'Ask the user to choose between options',
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String(),
          question: Type.String(),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.Optional(Type.String()),
            }),
          ),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const answers: Array<{ id: string; answer: unknown }> = [];
      for (const question of params.questions) {
        if (signal?.aborted) throw new Error('提问已取消');
        const askId = crypto.randomUUID();
        const options = question.options.map((option) =>
          option.description ? `${option.label}（${option.description}）` : option.label,
        );
        const response = await onAsk({
          askId,
          kind: 'select',
          message: question.question,
          options,
        });
        if (response.action !== 'accept') {
          return {
            content: [{ type: 'text', text: '用户取消了本次提问。请停止当前任务，等待用户下一步指示。' }],
            details: {},
          };
        }
        answers.push({ id: question.id, answer: response.content });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ answers }) }],
        details: {},
      };
    },
  });
}

export interface PiRunResult {
  code: number;
  aborted: boolean;
  error?: string;
  /** 配置/会话创建失败时为 false，避免上层把它当成“零产出”自动重试。 */
  retryable?: boolean;
  /** Provider stop reason（成功时通常为 stop/toolUse；失败时 error/aborted）。 */
  stopReason?: string;
}

export interface PiRunOptions {
  prompt: string;
  cwd: string;
  /** 模型 ID；省略时使用设置里的模型。 */
  model?: string | null;
  /** 创作阶段；model 未显式指定时用于解析按阶段默认模型（pi_stage_models）。 */
  stage?: string | null;
  thinkingLevel?: PiThinkingLevel;
  /** 是否启用 bash；默认关闭，避免 agent 越出项目目录。 */
  allowBash?: boolean;
  onEvent: (event: StreamEvent) => void;
  /**
   * 交互式提问：返回用户选择。提供时注册 ask 工具；
   * 由 runs.ts 接 registerAsk/SSE，用户回答后 resolve。
   */
  onAsk?: (ask: AskPrompt) => Promise<{ action: 'accept' | 'cancel'; content?: unknown }>;
  /** 提供时注册 open_novel_api 工具（受限的项目作用域本地 API 调用）。 */
  api?: OpenNovelApiToolOptions;
}

export interface PiRunHandle {
  promise: Promise<PiRunResult>;
  abort: () => void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function textFromToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
            return String((item as { text?: unknown }).text ?? '');
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return '';
}

function usageEvent(message: { usage?: unknown }, contextWindow: number, model: string | null): StreamEvent | null {
  const usage = message.usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      }
    | undefined;
  if (!usage) return null;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const totalTokens = usage.totalTokens ?? input + output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return {
    type: 'runtime_usage',
    used: totalTokens,
    size: contextWindow,
    costUsd: usage.cost?.total ?? null,
    // 成本面板按模型聚合需要 model id；旧事件无此字段，消费方按 null 处理
    model,
  };
}

function mapPiEvent(event: AgentSessionEvent, onEvent: (event: StreamEvent) => void, contextWindow: number, model: string | null): void {
  switch (event.type) {
    case 'message_update': {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === 'text_delta') {
        onEvent({ type: 'text_delta', delta: assistantEvent.delta });
      } else if (assistantEvent.type === 'thinking_delta') {
        onEvent({ type: 'thinking_delta', delta: assistantEvent.delta });
      } else if (assistantEvent.type === 'error') {
        onEvent({
          type: 'error',
          message: assistantEvent.error.errorMessage || '模型调用失败',
        });
      }
      return;
    }
    case 'tool_execution_start': {
      onEvent({
        type: 'tool_use',
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      });
      return;
    }
    case 'tool_execution_end': {
      onEvent({
        type: 'tool_result',
        toolUseId: event.toolCallId,
        content: textFromToolResult(event.result),
        isError: event.isError,
      });
      return;
    }
    case 'message_end': {
      if (event.message.role !== 'assistant') return;
      const runtimeUsage = usageEvent(event.message, contextWindow, model);
      if (runtimeUsage) onEvent(runtimeUsage);
      onEvent({
        type: 'usage',
        usage: {
          input_tokens: event.message.usage.input,
          output_tokens: event.message.usage.output,
          cache_read_input_tokens: event.message.usage.cacheRead,
          cache_creation_input_tokens: event.message.usage.cacheWrite,
        },
        costUsd: event.message.usage.cost.total,
      });
      if (event.message.stopReason === 'error') {
        onEvent({ type: 'error', message: event.message.errorMessage || '模型调用失败' });
      }
      return;
    }
    case 'auto_retry_start': {
      onEvent({
        type: 'status',
        label: `模型请求失败，${Math.ceil(event.delayMs / 1000)} 秒后重试（${event.attempt}/${event.maxAttempts}）`,
      });
      return;
    }
    case 'compaction_start': {
      onEvent({ type: 'status', label: '上下文压缩中…' });
      return;
    }
    case 'compaction_end': {
      onEvent({
        type: 'status',
        label: event.errorMessage ? `上下文压缩失败：${event.errorMessage}` : '上下文压缩完成',
      });
      return;
    }
    default:
      return;
  }
}

async function createPiSession(options: PiRunOptions): Promise<{
  session: AgentSession;
  contextWindow: number;
  /** 解析后的模型 id（runtime_usage 事件按模型聚合用）。 */
  modelId: string;
}> {
  const { runtime, settings } = await createPiModelRuntime();
  // 模型优先级：显式 model > 阶段默认（pi_stage_models 按 stage 解析）> 全局设置。
  // 阶段设置读取失败（DB 异常等）不阻断 run，静默回退全局。
  let stageModel: string | undefined;
  if (!options.model && options.stage) {
    try {
      stageModel = await resolveStagePiModel(options.stage);
    } catch {
      stageModel = undefined;
    }
  }
  const configured: PiSettings = options.model
    ? { ...settings, model: options.model }
    : stageModel
      ? { ...settings, model: stageModel }
      : settings;
  const model = await resolvePiModel(runtime, configured);

  const agentDir = piAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: PI_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const tools = [
    ...DEFAULT_TOOLS,
    ...(options.allowBash ? ['bash'] : []),
    ...(options.onAsk ? ['ask'] : []),
    ...(options.api ? ['open_novel_api'] : []),
  ];
  const customTools = [
    ...(options.onAsk ? [createAskTool(options.onAsk)] : []),
    ...(options.api ? [createOpenNovelApiTool(options.api)] : []),
  ];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: options.thinkingLevel ?? configured.thinkingLevel,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools,
    customTools,
  });

  return { session, contextWindow: model.contextWindow, modelId: model.id };
}

/**
 * 启动一个 Pi run。返回句柄后立即异步执行；abort() 可取消。
 * 事件在 session.prompt() 期间持续推送；promise 在 run 完成/失败/取消后结算。
 */
export function startPiAgent(options: PiRunOptions): PiRunHandle {
  let session: AgentSession | null = null;
  let aborted = false;
  let contextWindow = 0;

  const promise = (async (): Promise<PiRunResult> => {
    try {
      const setup = await createPiSession(options);
      session = setup.session;
      contextWindow = setup.contextWindow;

      if (aborted) {
        // 创建 session 期间用户已取消：不要再发 prompt。
        return { code: 1, aborted: true };
      }

      const unsubscribe = session.subscribe((event) => {
        try {
          mapPiEvent(event, options.onEvent, contextWindow, setup.modelId);
        } catch (err) {
          // 事件消费者异常不应中断 agent loop。
          options.onEvent({ type: 'error', message: `事件处理失败：${errorMessage(err)}` });
        }
      });

      try {
        await session.prompt(options.prompt);
        return { code: aborted ? 1 : 0, aborted, retryable: true };
      } finally {
        unsubscribe();
      }
    } catch (err) {
      const message = errorMessage(err);
      if (!aborted) {
        options.onEvent({ type: 'error', message });
      }
      // session 尚未创建 → 配置/凭据/模型错误，重试也不会成功。
      return { code: 1, aborted, error: message, retryable: session !== null };
    } finally {
      try {
        session?.dispose();
      } catch {
        /* dispose 失败不影响 run 结果 */
      }
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
      try {
        session?.abort();
      } catch {
        /* session 尚未创建或已结束 */
      }
    },
  };
}

/** 单次调用：只收集文本输出，供事实核查/时间线补全等非流式场景使用。 */
export async function callPiOnce(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  options?: { model?: string | null; allowBash?: boolean },
): Promise<string> {
  let output = '';
  let lastError = '';
  const handle = startPiAgent({
    prompt,
    cwd,
    model: options?.model,
    allowBash: options?.allowBash,
    onEvent: (event) => {
      if (event.type === 'text_delta') output += event.delta;
      else if (event.type === 'error') lastError = event.message;
    },
  });

  const timer = setTimeout(() => handle.abort(), timeoutMs);
  timer.unref?.();
  try {
    const result = await handle.promise;
    if (result.aborted) throw new Error('AI 调用超时，已中止当前任务');
    if (result.code !== 0) throw new Error(lastError || result.error || 'AI 调用失败');
    return output;
  } finally {
    clearTimeout(timer);
  }
}

export { PI_SYSTEM_PROMPT, DEFAULT_TOOLS };
