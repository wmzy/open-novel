/**
 * ACP (Agent Client Protocol) 桥接层。
 *
 * 把 omp（oh-my-pi）的 ACP JSON-RPC 协议转换为 open-novel 内部的 StreamEvent 模型，
 * 使 omp 与 claude/opencode 在 runs.ts / rewrite.ts 层面等价。
 *
 * 协议参考：https://agentclientprotocol.com/
 */
import { Writable, Readable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
  type ContentChunk,
  type ToolCall,
  type ToolCallUpdate,
  type AvailableCommandsUpdate,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { StreamEvent, AgentCommand, RuntimeModelOption, AskPrompt } from './types';
import { getRun, registerAsk } from './run';

type EventSink = (event: StreamEvent) => void;

/** 从 ACP configOptions 提取的模型信息。纯函数返回，便于测试。 */
export type AcpModelInfo = {
  models: RuntimeModelOption[];
  /** 用于 session/set_config_option 的 configId（omp 为 "model"）。 */
  configId: string | null;
  /** agent 当前选中的模型 id。 */
  currentModelId: string | null;
};

/**
 * 从 ACP NewSessionResponse.configOptions 提取模型列表与切换所需的 configId。
 *
 * 纯函数，便于单测。识别 category 为 `model` 或 `model_config` 的 select 项，
 * 支持扁平 options 和分组 options（group/name 展开格式）。
 *
 * 参考实现：open-design apps/daemon/src/acp.ts findModelConfigOption + normalizeModels。
 */
export function extractAcpModelInfo(
  configOptions: SessionConfigOption[] | null | undefined,
): AcpModelInfo | null {
  if (!configOptions || configOptions.length === 0) return null;

  const modelOption = configOptions.find(
    (o) => (o.category === 'model' || o.category === 'model_config') && o.type === 'select',
  );
  if (!modelOption || modelOption.type !== 'select') return null;

  const models: RuntimeModelOption[] = [];
  for (const opt of modelOption.options) {
    if ('value' in opt && 'name' in opt) {
      models.push({ id: opt.value, label: opt.name });
    } else if ('group' in opt && 'options' in opt) {
      for (const sub of opt.options) {
        models.push({ id: sub.value, label: `${opt.name} / ${sub.name}` });
      }
    }
  }

  return {
    models,
    configId: modelOption.id,
    currentModelId: modelOption.currentValue,
  };
}

/**
 * 从 ACP elicitation/create 请求参数构建 AskPrompt。
 *
 * 纯函数，便于单测。ACP 的 form 模式用 requestedSchema.properties.value 描述单个字段，
 * 根据 value 的 type 映射到 open-novel 的 AskPrompt.kind：
 * - string + enum → select（单选）
 * - string 无 enum → input（文本输入）
 * - boolean → confirm（确认）
 * - array → multiselect（多选）
 */
export function createAskPrompt(
  message: string,
  requestedSchema: { properties?: Record<string, unknown> } | null | undefined,
): AskPrompt {
  const valueProp = (requestedSchema?.properties?.value ?? {}) as Record<string, unknown>;
  const type = (valueProp.type as string) ?? 'string';
  const askId = randomUUID();

  if (type === 'boolean') {
    return { askId, kind: 'confirm', message };
  }
  if (type === 'array') {
    // ACP 多选：items 描述选项的 string schema，enum 或 oneOf 含选项值
    const items = (valueProp.items ?? {}) as Record<string, unknown>;
    const optionsMulti = extractEnumOptions(items);
    return { askId, kind: 'multiselect', message, optionsMulti };
  }
  if (type === 'string') {
    const options = extractEnumOptions(valueProp);
    if (options.length > 0) {
      return { askId, kind: 'select', message, options };
    }
    return {
      askId,
      kind: 'input',
      message,
      placeholder: (valueProp.description as string) || undefined,
    };
  }
  // 未知类型降级为文本输入，避免阻塞 agent
  return { askId, kind: 'input', message };
}

/** 从 ACP 属性 schema 提取枚举选项（enum 或 oneOf[].const）。 */
function extractEnumOptions(propSchema: Record<string, unknown>): string[] {
  const enumValues = propSchema.enum;
  if (Array.isArray(enumValues)) return enumValues.map(String);
  const oneOf = propSchema.oneOf;
  if (Array.isArray(oneOf)) {
    return oneOf
      .map((v) => (v as Record<string, unknown>)?.const)
      .filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/**
 * 把单个 ACP SessionUpdate 转换为 open-novel StreamEvent 数组。
 *
 * 纯函数，便于单测。映射关系：
 * - agent_message_chunk (text) → text_delta
 * - agent_thought_chunk (text) → thinking_delta
 * - tool_call → tool_use
 * - tool_call_update (completed/failed) → tool_result
 * - 其余（plan / usage_update / user_message_chunk 等）忽略
 */
export function convertSessionUpdate(update: SessionUpdate): StreamEvent[] {
  const events: StreamEvent[] = [];
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = (update as ContentChunk).content;
      if (content?.type === 'text' && content.text) {
        events.push({ type: 'text_delta', delta: content.text });
      }
      break;
    }
    case 'agent_thought_chunk': {
      const content = (update as ContentChunk).content;
      if (content?.type === 'text' && content.text) {
        events.push({ type: 'thinking_delta', delta: content.text });
      }
      break;
    }
    case 'tool_call': {
      const tc = update as ToolCall;
      events.push({
        type: 'tool_use',
        id: tc.toolCallId,
        name: tc.title || tc.kind || 'tool',
        input: tc.rawInput ?? tc.content ?? null,
      });
      break;
    }
    case 'tool_call_update': {
      const tcu = update as ToolCallUpdate;
      if (tcu.status === 'completed' || tcu.status === 'failed') {
        const raw = tcu.rawOutput;
        const content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        events.push({
          type: 'tool_result',
          toolUseId: tcu.toolCallId,
          content,
          isError: tcu.status === 'failed',
        });
      }
      break;
    }
    case 'available_commands_update': {
      const acu = update as AvailableCommandsUpdate;
      events.push({
        type: 'commands',
        commands: acu.availableCommands.map((c) => ({
          name: c.name,
          description: c.description,
          inputHint: c.input?.hint ?? undefined,
        })),
      });
      break;
    }
    default:
      // plan / plan_update / plan_removed / usage_update / user_message_chunk /
      // current_mode_update / config_option_update / session_info_update
      break;
  }
  return events;
}

/**
 * 判定 ACP 会话的 stopReason 是否为显式失败。
 *
 * 只有 refusal / max_turn_requests / error 是失败；null（close 在 runAcpTurn resolve 前
 * 触发，如 timeout kill / 进程自行退出）与正常 stopReason（end_turn / max_tokens / stopped）
 * 都不算失败。这样 close 竞态时不会误丢已产生的 agent 响应。
 */
export function isAcpFailure(stopReason: string | null | undefined): boolean {
  return stopReason === 'refusal' || stopReason === 'max_turn_requests' || stopReason === 'error';
}

/**
 * 在已 spawn 的 omp acp 子进程上运行一轮 prompt。
 *
 * 流程：initialize → session/new → session/prompt，同时读 session/update 通知流转为 StreamEvent。
 * omp 在 yolo/bypassPermissions 模式下不会请求权限；handler 仅作兜底自动批准。
 *
 * @returns stopReason（end_turn / max_tokens / cancelled / refusal / max_turn_requests）
 */
export async function runAcpTurn(
  child: ChildProcess,
  prompt: string,
  cwd: string,
  extraDirs: string[],
  onEvent: EventSink,
  model?: string,
  runId?: string,
): Promise<{ stopReason: string }> {
  if (!child.stdin || !child.stdout) {
    throw new Error('ACP child process missing stdin/stdout pipes');
  }

  const writable = Writable.toWeb(child.stdin);
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const transport = ndJsonStream(writable, readable);

  const app = client({ name: 'open-novel' })
    .onRequest(
      'session/request_permission',
      async (ctx) => {
        const first = ctx.params.options[0];
        return {
          outcome: first
            ? { outcome: 'selected' as const, optionId: first.optionId }
            : { outcome: 'cancelled' as const },
        };
      },
    )
    .onRequest('elicitation/create', async (ctx) => {
      // CreateElicitationRequest 是 discriminated union（mode: form | url）。
      // 仅处理 form 模式；url 模式（浏览器跳转）当前不支持，取消。
      const params = ctx.params as Record<string, unknown>;
      const message = (params.message as string) ?? '';
      const requestedSchema =
        params.mode === 'form'
          ? ((params as Record<string, unknown>).requestedSchema as { properties?: Record<string, unknown> })
          : null;
      const ask = createAskPrompt(message, requestedSchema);

      if (runId) {
        const run = getRun(runId);
        if (run) {
          // 推给前端，等用户回传
          onEvent({ type: 'ask', ask });
          const response = await registerAsk(run, ask.askId);
          if (response.action === 'accept') {
            return {
              action: 'accept' as const,
              content: (response.content ?? { value: undefined }) as Record<string, unknown> as never,
            };
          }
        }
      }
      // 无 runId（如 probe 会话）或 run 已结束：取消，不阻塞 agent
      return { action: 'cancel' as const };
    });

  let stopReason = 'end_turn';

  await app.connectWith(transport, async (ctx) => {
    // 声明 client capability：elicitation.form（让 omp 知道可以向用户提问）。
    // SDK 高级 API 不自动发 initialize，需手动发。
    // omp 的 createAcpExtensionUiContext 检查 clientCapabilities.elicitation.form != null。
    await ctx.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: { form: {} },
      },
    });

    const builder = ctx.buildSession(cwd);
    if (extraDirs.length > 0) builder.withAdditionalDirectories(extraDirs);
    const session = await builder.start();

    // 切换模型：ACP configOptions 里 category=model 的 select 项
    // omp 的 configId 为 "model"，通过 session/set_config_option 切换。
    // model='default'/undefined 时不切换，agent 使用自身当前模型。
    if (model && model !== 'default') {
      const info = extractAcpModelInfo(session.newSessionResponse.configOptions);
      if (info?.configId) {
        await ctx.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: info.configId,
          value: model,
        });
      }
    }

    // prompt() 异步等响应；通知通过 nextUpdate() 并行读
    const promptPromise = session.prompt(prompt).catch(() => null);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const msg = await session.nextUpdate();
      if (msg.kind === 'stop') {
        stopReason = msg.stopReason;
        break;
      }
      for (const ev of convertSessionUpdate(msg.update)) {
        onEvent(ev);
      }
    }

    await promptPromise;
  });

  return { stopReason };
}

/**
 * 起一个短命 omp acp 会话，只为了拿 bootstrap 阶段推送的 available_commands_update。
 *
 * 用于首屏预取 agent slash command 列表（无需用户先发消息）。
 * 拿到命令或超时后立即 kill 子进程；不发送任何 prompt。
 */
export async function probeAcpCommands(
  bin: string,
  cwd: string,
  extraDirs: string[] = [],
  timeoutMs = 5000,
): Promise<AgentCommand[]> {
  const child = spawn(bin, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let settled = false;

  const cleanup = () => {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  };

  const timer = setTimeout(() => {
    if (!settled) { settled = true; cleanup(); }
  }, timeoutMs);

  try {
    if (!child.stdin || !child.stdout) throw new Error('probe: missing stdio');
    const writable = Writable.toWeb(child.stdin);
    const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const transport = ndJsonStream(writable, readable);
    const app = client({ name: 'open-novel' });

    const commands = await app.connectWith(transport, async (ctx) => {
      const builder = ctx.buildSession(cwd);
      if (extraDirs.length > 0) builder.withAdditionalDirectories(extraDirs);
      const session = await builder.start();

      // omp 在 session/new 后延迟推送 available_commands_update；循环读直到拿到或超时
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const msg = await session.nextUpdate();
        if (msg.kind === 'stop') break;
        const u = msg.update as SessionUpdate;
        if (u.sessionUpdate === 'available_commands_update') {
          const acu = u as AvailableCommandsUpdate;
          return acu.availableCommands.map((c) => ({
            name: c.name,
            description: c.description,
            inputHint: c.input?.hint ?? undefined,
          }));
        }
      }
      return [];
    });

    settled = true;
    return commands;
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

/**
 * 起一个短命 omp acp 会话，拉取 agent 支持的模型列表。
 *
 * configOptions 随 session/new 响应返回（无需等通知），拿到后立即 kill。
 * 适用于所有实现 ACP configOptions (category=model) 的 agent，不需 per-agent 定制。
 */
export async function probeAcpModels(
  bin: string,
  cwd: string,
  extraDirs: string[] = [],
  timeoutMs = 8000,
): Promise<RuntimeModelOption[]> {
  const child = spawn(bin, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let settled = false;

  const cleanup = () => {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  };

  const timer = setTimeout(() => {
    if (!settled) { settled = true; cleanup(); }
  }, timeoutMs);

  try {
    if (!child.stdin || !child.stdout) throw new Error('probe: missing stdio');
    const writable = Writable.toWeb(child.stdin);
    const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const transport = ndJsonStream(writable, readable);
    const app = client({ name: 'open-novel' });

    const models = await app.connectWith(transport, async (ctx) => {
      const builder = ctx.buildSession(cwd);
      if (extraDirs.length > 0) builder.withAdditionalDirectories(extraDirs);
      const session = await builder.start();
      // configOptions 随 session/new 响应返回，无需循环等通知
      const info = extractAcpModelInfo(session.newSessionResponse.configOptions);
      return info?.models ?? [];
    });

    settled = true;
    return models;
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}
