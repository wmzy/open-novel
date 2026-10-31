#!/usr/bin/env node
/**
 * P2 长程一致性评测薄壳（不改 package.json，一条命令可跑）：
 *   node scripts/eval-consistency.mjs                    # 100 章（默认）
 *   EVAL_CHAPTERS=300 node scripts/eval-consistency.mjs  # 300 章（夜间 CI 规模）
 *   EVAL_JUDGE=1 …                                       # 有 Pi 凭据时追加 LLM judge
 *   EVAL_JUDGE=1 EVAL_JUDGE_MODEL=gpt-4.1-mini …        # judge 用独立便宜模型
 *
 * 等价命令（父任务 npm script 可直接引用其中之一）：
 *   EVAL_RUN=1 npx vitest run tests/eval/ --maxWorkers=4 --disable-console-intercept
 *
 * （--disable-console-intercept 只是让摘要直通终端，可省略；JSON 产物始终落盘。）
 *
 * 行为：透传 EVAL_CHAPTERS/EVAL_JUDGE，设置 EVAL_RUN=1 后调用本地 vitest
 * 跑 tests/eval/（见 tests/eval/consistency.eval.test.ts），并透传退出码
 * （P0 命中率跌破 90% 等门槛失败 → 非零退出）。产物：
 * tests/eval/results/consistency-<N>ch.json（已 gitignore）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(root, 'node_modules', '.bin', 'vitest');

if (!fs.existsSync(vitestBin)) {
  console.error('[eval] 未找到 node_modules/.bin/vitest；请先运行 pnpm install');
  process.exit(1);
}

const chapters = process.env.EVAL_CHAPTERS?.trim() || '';
const judgeModel = process.env.EVAL_JUDGE_MODEL?.trim() || '';
console.log(
  `[eval] 启动长程一致性评测：${chapters ? `${chapters} 章` : '默认 100 章'}；` +
  `LLM judge ${process.env.EVAL_JUDGE === '1' ? `已请求${judgeModel ? `（${judgeModel}）` : ''}` : '未请求'}`,
);

const child = spawnSync(
  vitestBin,
  // --disable-console-intercept：让评测的人类可读摘要（console.log）直通终端，
  // 否则 vitest 4 默认拦截通过用例的控制台输出。
  ['run', 'tests/eval/', '--maxWorkers=4', '--disable-console-intercept'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      EVAL_RUN: '1',
      // 显式回填，保证 vitest 子进程一定看到（即使父进程用空串清空过）。
      ...(chapters ? { EVAL_CHAPTERS: chapters } : {}),
    },
  },
);

if (child.error) {
  console.error(`[eval] 启动 vitest 失败：${child.error.message}`);
  process.exit(1);
}
process.exit(child.status ?? 1);
