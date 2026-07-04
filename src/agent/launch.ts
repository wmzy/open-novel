import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeAgentDef } from './types';
import { resolveAgentExecutable } from './executables';

export interface AgentProcess {
  child: ReturnType<typeof spawn>;
  stdin: NodeJS.WritableStream | null;
}

export function launchAgent(
  def: RuntimeAgentDef,
  prompt: string,
  cwd: string,
  extraDirs: string[] = [],
  model?: string,
): AgentProcess {
  const bin = resolveAgentExecutable(def);
  if (!bin) throw new Error(`Agent ${def.id} not found on PATH`);

  const args = def.buildArgs(prompt, extraDirs, { model });
  const env = { ...process.env };
  const binDir = path.dirname(bin);
  env.PATH = [binDir, env.PATH].filter(Boolean).join(path.delimiter);

  mkdirSync(cwd, { recursive: true });

  // ACP 协议需要 stdin/stdout 双向 pipe；prompt 由调用方经协议发
  const useStdinPipe = def.usesAcp || def.promptViaStdin;
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  if (def.usesAcp) {
    // ACP: 不向 stdin write prompt；runAcpTurn 会经 JSON-RPC 发送
    return { child, stdin: child.stdin };
  }

  if (def.promptViaStdin && def.promptInputFormat === 'stream-json' && child.stdin) {
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    child.stdin.write(msg + '\n');
    // Keep stdin open for interactive tool results
  } else if (def.promptViaStdin && child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  return { child, stdin: child.stdin };
}
