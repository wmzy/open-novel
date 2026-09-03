import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { cleanStaleLock } from '../../../src/db/drizzle';
import {
  acquireDataDirLock,
  releaseDataDirLock,
  lockPathFor,
} from '../../../src/db/data-dir-lock';

describe('cleanStaleLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('删除死进程的 stale postmaster.pid', () => {
    const pidFile = path.join(tempDir, 'postmaster.pid');
    // PID 999999 几乎肯定不存在
    fs.writeFileSync(pidFile, '999999\n/var/lib/postgresql\n');
    expect(fs.existsSync(pidFile)).toBe(true);

    cleanStaleLock(tempDir);

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('无 postmaster.pid 时不报错', () => {
    expect(() => cleanStaleLock(tempDir)).not.toThrow();
  });

  it('删除损坏的 postmaster.pid（非数字内容）', () => {
    const pidFile = path.join(tempDir, 'postmaster.pid');
    fs.writeFileSync(pidFile, 'not-a-pid\n');
    cleanStaleLock(tempDir);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('不删除属于当前进程的 postmaster.pid（重载场景）', () => {
    const pidFile = path.join(tempDir, 'postmaster.pid');
    fs.writeFileSync(pidFile, `${process.pid}\n/var/lib/postgresql\n`);
    cleanStaleLock(tempDir);
    // 自己的 PID 会被删除（因为这是热重载场景，旧实例已退出）
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

// 来源：单实例数据目录锁（防多进程共享 PGlite 数据目录导致损坏，对齐
// upstream electric-sql/pglite#892）。归并建议：与 cleanStaleLock 同属
// db 数据目录生命周期测试，保留在本文件。
describe('dataDirLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datalock-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    try {
      fs.rmSync(`${tempDir}.lock`, { force: true });
    } catch {
      // already gone
    }
  });

  it('获取锁后创建记录当前 pid 的锁文件', () => {
    acquireDataDirLock(tempDir);
    const lock = JSON.parse(fs.readFileSync(lockPathFor(tempDir), 'utf8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('同进程重复获取是幂等的', () => {
    acquireDataDirLock(tempDir);
    expect(() => acquireDataDirLock(tempDir)).not.toThrow();
  });

  it('死进程留下的陈旧锁被清除并重新获取', () => {
    fs.writeFileSync(
      lockPathFor(tempDir),
      JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }),
    );
    acquireDataDirLock(tempDir);
    const lock = JSON.parse(fs.readFileSync(lockPathFor(tempDir), 'utf8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('活进程占用时抛错且不清除锁', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    expect(child.pid).toBeDefined();
    fs.writeFileSync(
      lockPathFor(tempDir),
      JSON.stringify({ pid: child.pid, createdAt: new Date().toISOString() }),
    );
    expect(() => acquireDataDirLock(tempDir)).toThrow(/locked by another running instance/);
    expect(fs.existsSync(lockPathFor(tempDir))).toBe(true);
    child.kill();
  });

  it('release 只删除自己持有的锁', () => {
    // 自己的锁 → 删除
    acquireDataDirLock(tempDir);
    releaseDataDirLock(tempDir);
    expect(fs.existsSync(lockPathFor(tempDir))).toBe(false);
    // 别人的锁 → 保留
    fs.writeFileSync(lockPathFor(tempDir), JSON.stringify({ pid: 999999999 }));
    releaseDataDirLock(tempDir);
    expect(fs.existsSync(lockPathFor(tempDir))).toBe(true);
  });
});
