/**
 * 单次调用内置 Pi agent 并同步收集文本输出。
 *
 * 供事实核查、时间线补全等非流式场景使用；不再启动外部 CLI。
 */
import { callPiOnce } from './pi/runtime';

/** 默认超时：10 分钟（逐章调用场景）。 */
export const DEFAULT_AGENT_ONCE_TIMEOUT_MS = 10 * 60 * 1000;

export async function callAgentOnce(
  prompt: string,
  cwd: string,
  timeoutMs: number = DEFAULT_AGENT_ONCE_TIMEOUT_MS,
): Promise<string> {
  return callPiOnce(prompt, cwd, timeoutMs);
}
