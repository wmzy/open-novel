import { launchAgent, type AgentProcess } from './launch';
import { createClaudeStreamHandler, createJsonEventHandler } from './stream-parser';
import type { StreamEvent, RuntimeAgentDef } from './types';

/** 默认超时：10 分钟（逐章调用场景）。 */
const DEFAULT_AGENT_ONCE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 单次调用 agent 并同步收集文本输出。
 *
 * 复用 launchAgent + 流解析；timeoutMs 到期杀掉子进程并拒绝。
 * onChild 回调用于把子进程挂到 run 上（取消时杀掉当前子进程）。
 * ACP agent 不走此函数（其协议需双向 JSON-RPC，见 acp-bridge）。
 */
export async function callAgentOnce(
  def: RuntimeAgentDef,
  prompt: string,
  cwd: string,
  timeoutMs: number = DEFAULT_AGENT_ONCE_TIMEOUT_MS,
  onChild?: (child: AgentProcess['child']) => void,
): Promise<string> {
  if (def.usesAcp) throw new Error('callAgentOnce 暂不支持 ACP agent');

  const { child } = launchAgent(def, prompt, cwd, [], undefined);
  onChild?.(child);

  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      finish(() => reject(new Error('AI 调用超时，已中止当前章节')));
    }, timeoutMs);
    timer.unref?.();

    const onEvent = (event: StreamEvent) => {
      if (event.type === 'text_delta') output += String(event.delta || '');
    };
    const handler = def.streamFormat === 'claude-stream-json'
      ? createClaudeStreamHandler(onEvent)
      : createJsonEventHandler(onEvent);

    child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
    // 排空 stderr，避免背压
    child.stderr?.on('data', () => {});
    child.on('close', (code) => {
      handler.flush();
      if (code === 0) finish(() => resolve(output));
      else finish(() => reject(new Error('AI 调用失败，agent 异常退出')));
    });
    child.on('error', (e) => finish(() => reject(new Error(`AI 调用失败：${e.message}`))));
  });
}
