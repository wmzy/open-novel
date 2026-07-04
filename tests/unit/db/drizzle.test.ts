import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanStaleLock } from '../../../src/db/drizzle';

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
