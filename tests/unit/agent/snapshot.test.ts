import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureGitInit, createSnapshot, ensureDraftBranch } from '../../../src/agent/snapshot';

const execFileAsync = promisify(execFile);

/** 创建一个已初始化、有初始 commit 的临时 git 仓库。 */
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-test-'));
  await ensureGitInit(dir);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await createSnapshot(dir, 'init');
  return dir;
}

/** 读取当前分支名。 */
async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

/** 判断分支是否存在。 */
async function branchExists(dir: string, name: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', name], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

describe('ensureDraftBranch', () => {
  let dir: string;

  beforeEach(async () => { dir = await makeRepo(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('无 draft 时从当前 HEAD 创建 draft + main，并 checkout 到 draft', async () => {
    await ensureDraftBranch(dir);
    expect(await currentBranch(dir)).toBe('draft');
    expect(await branchExists(dir, 'draft')).toBe(true);
    expect(await branchExists(dir, 'main')).toBe(true);
  });

  it('已有 draft 时幂等（不报错，仍在 draft）', async () => {
    await ensureDraftBranch(dir);
    await ensureDraftBranch(dir);
    expect(await currentBranch(dir)).toBe('draft');
  });

  it('working tree 在 main 时切到 draft', async () => {
    await ensureDraftBranch(dir);
    await execFileAsync('git', ['checkout', 'main'], { cwd: dir });
    expect(await currentBranch(dir)).toBe('main');
    await ensureDraftBranch(dir);
    expect(await currentBranch(dir)).toBe('draft');
  });
});
