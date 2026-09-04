import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

/**
 * Agent 子进程注册表。
 *
 * open-novel 崩溃（非优雅退出）时，spawn 出的 claude/opencode CLI 成为
 * 孤儿进程继续写项目文件；新实例的 runs Map 为空 → 项目串行锁判定「无
 * 活跃 run」→ 用户开新 run 后两个 agent 并发写同一项目，恰好踩中串行锁
 * 要防的 last-writer-wins 污染。
 *
 * 该模块把「本进程 spawn 过、仍在运行的 agent 子进程」持久化到
 * data/agent-children.json（按 PID 登记）。启动时对账：仍存活且命令行
 * 确为 agent CLI 的孤儿进程杀掉；优雅退出时主动清理。PID 复用的风险用
 * /proc/<pid>/cmdline 内容校验兜底（非 agent 进程绝不误杀）。
 */

const REGISTRY_FILE = path.resolve(process.env.AGENT_CHILD_FILE || './data/agent-children.json');

interface ChildEntry {
  pid: number;
  agent: string;
  startedAt: number;
}

let entries = new Map<number, ChildEntry>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')) as unknown;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const e = item as Partial<ChildEntry>;
        if (typeof e.pid === 'number' && typeof e.agent === 'string') {
          entries.set(e.pid, { pid: e.pid, agent: e.agent, startedAt: typeof e.startedAt === 'number' ? e.startedAt : 0 });
        }
      }
    }
  } catch {
    /* 文件不存在/损坏：按空注册表处理 */
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...entries.values()], null, 2), 'utf-8');
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch {
    /* 持久化失败不阻断 agent 启动 */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

function pidCmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/** 命令行是否确为 agent CLI（PID 复用检测：非 agent 进程绝不误杀）。 */
function isAgentCmdline(cmdline: string, agent: string): boolean {
  if (!cmdline) return false;
  // 宽松匹配二进制名（路径分隔符/空格/行尾），防子串误判（如 "myclaude-tool"）
  const bin = /(?:^|[\\/ ])(claude|opencode)(?:[ .]|$)/i;
  if (bin.test(cmdline)) return true;
  return new RegExp(`(?:^|[\\\\/ ])${escapeRegExp(agent)}(?:[ .]|$)`, 'i').test(cmdline);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** spawn 成功后登记；子进程退出时自动注销。 */
export function registerAgentChild(child: ChildProcess, agentId: string): void {
  if (!child.pid) return;
  load();
  const pid = child.pid;
  entries.set(pid, { pid, agent: agentId, startedAt: Date.now() });
  persist();
  child.once('exit', () => {
    load();
    if (entries.delete(pid)) persist();
  });
}

/**
 * 启动对账：杀掉上次进程遗留的孤儿 agent 子进程。
 * SIGTERM 后宽限 2s，仍存活则 SIGKILL。返回杀掉的数量。
 */
export async function killOrphanAgentChildren(): Promise<number> {
  load();
  let killed = 0;
  const stale: Array<{ pid: number; agent: string }> = [];
  for (const [pid, entry] of [...entries.entries()]) {
    if (!pidAlive(pid)) {
      entries.delete(pid);
      continue;
    }
    if (!isAgentCmdline(pidCmdline(pid), entry.agent)) {
      // PID 已复用给无关进程：只清理登记，不误杀
      entries.delete(pid);
      continue;
    }
    stale.push({ pid, agent: entry.agent });
  }
  persist();

  for (const { pid } of stale) {
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
    } catch {
      /* 已退出 */
    }
  }
  if (killed > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const { pid } of stale) {
      if (!pidAlive(pid)) {
        entries.delete(pid);
        continue;
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    persist();
  }
  return killed;
}

/** 优雅退出：SIGTERM 所有仍登记的 agent 子进程（不等待，宽限交给进程退出时序）。 */
export function killAllAgentChildren(): void {
  load();
  for (const [pid] of [...entries.entries()]) {
    if (!pidAlive(pid)) {
      entries.delete(pid);
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
  persist();
}
