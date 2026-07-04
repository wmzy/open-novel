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
  type SessionUpdate,
  type ContentChunk,
  type ToolCall,
  type ToolCallUpdate,
  type AvailableCommandsUpdate,
} from '@agentclientprotocol/sdk';
import type { ChildProcess } from 'node:child_process';
import type { StreamEvent } from './types';

type EventSink = (event: StreamEvent) => void;

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
): Promise<{ stopReason: string }> {
  if (!child.stdin || !child.stdout) {
    throw new Error('ACP child process missing stdin/stdout pipes');
  }

  const writable = Writable.toWeb(child.stdin);
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const transport = ndJsonStream(writable, readable);

  const app = client({ name: 'open-novel' }).onRequest(
    'session/request_permission',
    async (ctx) => {
      const first = ctx.params.options[0];
      return {
        outcome: first
          ? { outcome: 'selected' as const, optionId: first.optionId }
          : { outcome: 'cancelled' as const },
      };
    },
  );

  let stopReason = 'end_turn';

  await app.connectWith(transport, async (ctx) => {
    const builder = ctx.buildSession(cwd);
    if (extraDirs.length > 0) builder.withAdditionalDirectories(extraDirs);
    const session = await builder.start();

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
