import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureGitInit, createSnapshot, ensureDraftBranch, reviewDiff, mergeDraft, discardDraft, restoreSnapshot } from '../../../src/agent/snapshot';

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

describe('reviewDiff', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('draft==main 时返回空审阅', async () => {
    const r = await reviewDiff(dir);
    expect(r.commits).toHaveLength(0);
    expect(r.files).toHaveLength(0);
    expect(r.totalAdded).toBe(0);
    expect(r.totalRemoved).toBe(0);
  });

  it('draft 领先 main 时返回 commit 列表 + per-file diff', async () => {
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章内容\n');
    await createSnapshot(dir, '写第一章');

    const r = await reviewDiff(dir);
    expect(r.commits.length).toBeGreaterThanOrEqual(1);
    expect(r.files.some((f) => f.path === 'ch1.md')).toBe(true);
    const ch1 = r.files.find((f) => f.path === 'ch1.md')!;
    expect(ch1.status).toBe('added');
    expect(ch1.addedLines).toBeGreaterThan(0);
    expect(ch1.diff).toContain('+第一章内容');
    expect(r.totalAdded).toBeGreaterThan(0);
  });

  it('working tree 有未提交改动时先 checkpoint commit，diff 包含之', async () => {
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
    // 未提交改动
    await fs.writeFile(path.join(dir, 'ch2.md'), '第二章\n');

    const r = await reviewDiff(dir);
    expect(r.files.some((f) => f.path === 'ch2.md')).toBe(true);
  });

  it('修改/删除文件状态正确', async () => {
    await fs.writeFile(path.join(dir, 'ch1.md'), 'AAA\nBBB\nCCC\n');
    await createSnapshot(dir, '加 ch1');
    await fs.writeFile(path.join(dir, 'ch1.md'), 'AAA\nXXX\nCCC\n'); // 修改
    await fs.rm(path.join(dir, 'README.md')); // 删除
    await createSnapshot(dir, '改 ch1 删 README');

    const r = await reviewDiff(dir);
    const ch1 = r.files.find((f) => f.path === 'ch1.md');
    const readme = r.files.find((f) => f.path === 'README.md');
    expect(ch1?.status).toBe('modified');
    expect(readme?.status).toBe('deleted');
  });
});

/** 读取 main 分支指向的 commit hash。 */
async function mainHash(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: dir });
  return stdout.trim();
}
async function draftHash(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'draft'], { cwd: dir });
  return stdout.trim();
}

describe('restoreSnapshot', () => {
  let dir: string;
  let baseHash: string;

  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
    // 里程碑：README.md（makeRepo 已有 init commit）
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
    baseHash = stdout.trim();
    // 快照之后新增章节文件
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
    await fs.writeFile(path.join(dir, 'ch2.md'), '第二章\n');
    await createSnapshot(dir, '写第二章');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('回滚到早期快照后，快照之后新增的文件被删除（不再残留幽灵章节）', async () => {
    const ok = await restoreSnapshot(dir, baseHash);
    expect(ok).toBe(true);
    // 新增文件已删除
    await expect(fs.access(path.join(dir, 'ch1.md'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'ch2.md'))).rejects.toThrow();
    // 快照内文件保留（README.md 是 init commit 内容）
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf-8')).toBe('init\n');
  });

  it('回滚前创建安全提交，当前状态可找回', async () => {
    // 未提交改动：回滚前安全提交应把它落盘（全部已提交时无需安全提交）
    await fs.writeFile(path.join(dir, 'ch3.md'), '第三章（未提交）\n');
    await restoreSnapshot(dir, baseHash);
    const { stdout } = await execFileAsync('git', ['log', '--format=%s', '-3'], { cwd: dir });
    expect(stdout).toContain('pre-rollback safety');
    // 安全提交可检出：ch3 内容在历史中找回
    const { stdout: safetyHash } = await execFileAsync('git', ['log', '--format=%H', '--grep=pre-rollback safety', '-1'], { cwd: dir });
    expect(safetyHash.trim()).toBeTruthy();
  });

  it('#7: 回滚结果落为显式 commit（工作区干净，不再被 discard 静默吞掉）', async () => {
    const ok = await restoreSnapshot(dir, baseHash);
    expect(ok).toBe(true);
    const { stdout } = await execFileAsync('git', ['log', '--format=%s', '-1'], { cwd: dir });
    expect(stdout).toContain('rollback to');
    // 工作区干净：回滚已提交
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
    expect(statusOut.trim()).toBe('');
  });
});

describe('mergeDraft', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('ff main 到 draft，merge 后 main==draft，working tree 回到 draft', async () => {
    const beforeDraft = await draftHash(dir);
    const res = await mergeDraft(dir);
    expect(res.success).toBe(true);
    expect(res.fastForward).toBe(true);
    expect(await mainHash(dir)).toBe(beforeDraft);
    expect(await currentBranch(dir)).toBe('draft');
  });

  it('merge 后 reviewDiff 为空', async () => {
    await mergeDraft(dir);
    const r = await reviewDiff(dir);
    expect(r.commits).toHaveLength(0);
  });
});

describe('discardDraft', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reset draft 到 main，丢弃 commit + working tree 改动', async () => {
    const beforeMain = await mainHash(dir);
    const res = await discardDraft(dir);
    expect(res.success).toBe(true);
    expect(await draftHash(dir)).toBe(beforeMain);
    // 文件被丢弃
    await expect(fs.access(path.join(dir, 'ch1.md'))).rejects.toThrow();
  });

  it('discard 后 reviewDiff 为空', async () => {
    await discardDraft(dir);
    const r = await reviewDiff(dir);
    expect(r.commits).toHaveLength(0);
  });
});
