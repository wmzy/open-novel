/**
 * src/db/recovery.ts 数据目录修复工具的测试。
 *
 * 来源：启动健康检查失败时自动从备份恢复（docs/代码优化建议 P0-1），以及
 * PG17→PG18 迁移后的备份兼容性校验。依赖系统 tar（Linux/macOS/Windows 10+
 * 均内置）。
 *
 * 归并建议：与 drizzle.test.ts、backup.test.ts 同属 db 层测试，保留在
 * tests/unit/db/ 下；若 db 测试文件重组可合并为 db-recovery.test.ts。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  cleanStaleLock,
  extractBackupTo,
  isBackupVersionCompatible,
  preflightDataDir,
  readDataDirPgVersion,
  readPgVersionFromTar,
} from '../../../src/db/recovery';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTar(srcDir: string, tarPath: string): void {
  execFileSync('tar', ['-czf', tarPath, '-C', srcDir, '.'], { stdio: 'ignore' });
}

describe('readPgVersionFromTar', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir('recovery-tar-');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('读取 tar 内 PG_VERSION', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '18\n');
    const tarPath = path.join(tmp, 'backup.tar.gz');
    makeTar(src, tarPath);
    expect(await readPgVersionFromTar(tarPath)).toBe('18');
  });

  it('非 tar 文件返回 null', async () => {
    const junk = path.join(tmp, 'junk.tar.gz');
    fs.writeFileSync(junk, 'not a tarball');
    expect(await readPgVersionFromTar(junk)).toBeNull();
  });

  it('tar 内无 PG_VERSION 时返回 null', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'other.txt'), 'x');
    const tarPath = path.join(tmp, 'backup.tar.gz');
    makeTar(src, tarPath);
    expect(await readPgVersionFromTar(tarPath)).toBeNull();
  });
});

describe('readDataDirPgVersion', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir('recovery-dir-');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('读取数据目录 PG_VERSION 文件', async () => {
    fs.writeFileSync(path.join(tmp, 'PG_VERSION'), '17\n');
    expect(await readDataDirPgVersion(tmp)).toBe('17');
  });

  it('目录缺失或文件不存在时返回 null', async () => {
    expect(await readDataDirPgVersion(path.join(tmp, 'nope'))).toBeNull();
  });
});

describe('isBackupVersionCompatible', () => {
  it('主版本一致时兼容', () => {
    expect(isBackupVersionCompatible('18', '18')).toBe(true);
  });

  it('主版本不一致时跳过（PG17 备份不能恢复进 PG18）', () => {
    expect(isBackupVersionCompatible('17', '18')).toBe(false);
  });

  it('任一侧未知时按兼容处理（恢复本身是最终裁决）', () => {
    expect(isBackupVersionCompatible(null, '18')).toBe(true);
    expect(isBackupVersionCompatible('17', null)).toBe(true);
    expect(isBackupVersionCompatible(null, null)).toBe(true);
  });
});

describe('preflightDataDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir('preflight-');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('目录不存在或为空时不报错（PGlite 将正常 initdb）', () => {
    // 不存在的目录
    expect(() => preflightDataDir(path.join(tmp, 'missing'))).not.toThrow();
    // 空目录（mkdtemp 已创建）
    expect(() => preflightDataDir(tmp)).not.toThrow();
  });

  it('非空目录带合法 PG_VERSION 时不报错', () => {
    fs.writeFileSync(path.join(tmp, 'PG_VERSION'), '18\n');
    fs.writeFileSync(path.join(tmp, 'base'), 'x');
    expect(() => preflightDataDir(tmp)).not.toThrow();
  });

  it('非空目录缺 PG_VERSION 时抛错（阻止静默 initdb 毁数据）', () => {
    fs.writeFileSync(path.join(tmp, 'base'), 'x');
    expect(() => preflightDataDir(tmp)).toThrow(/no readable PG_VERSION/);
  });

  it('非空目录 PG_VERSION 非法时抛错', () => {
    fs.writeFileSync(path.join(tmp, 'PG_VERSION'), 'not-a-version');
    fs.writeFileSync(path.join(tmp, 'base'), 'x');
    expect(() => preflightDataDir(tmp)).toThrow(/no readable PG_VERSION/);
  });
});

describe('extractBackupTo + cleanStaleLock', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir('recovery-extract-');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('解包备份到目标目录并清理残留 postmaster.pid', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'base', '1'), { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '18\n');
    fs.writeFileSync(path.join(src, 'base', '1', '123'), 'data');
    // 备份时进程仍在运行 → tar 内含 postmaster.pid（死 pid）
    fs.writeFileSync(path.join(src, 'postmaster.pid'), '999999999\n/data\n');

    const tarPath = path.join(tmp, 'backup.tar.gz');
    makeTar(src, tarPath);

    const target = path.join(tmp, 'restored');
    await extractBackupTo(tarPath, target);
    cleanStaleLock(target);

    expect(fs.readFileSync(path.join(target, 'PG_VERSION'), 'utf8').trim()).toBe('18');
    expect(fs.readFileSync(path.join(target, 'base', '1', '123'), 'utf8')).toBe('data');
    expect(fs.existsSync(path.join(target, 'postmaster.pid'))).toBe(false);
  });
});

describe('启动失败自动从备份恢复（端到端）', () => {
  it(
    '损坏数据目录后 ensureDbReady 自动恢复数据',
    { timeout: 120_000 },
    async () => {
      vi.resetModules();
      const { ensureDbReady, getPglite, getPgliteDataDir, closeDb } = await import(
        '../../../src/db/drizzle'
      );
      const { backupDataDir } = await import('../../../src/db/backup');

      // 正常初始化，写入数据，做一次备份
      await ensureDbReady();
      const pglite = getPglite();
      await pglite.exec('CREATE TABLE IF NOT EXISTS recovery_probe (id int)');
      await pglite.exec('INSERT INTO recovery_probe VALUES (1)');
      const backup = await backupDataDir();
      expect(backup.created).toBe(true);

      await closeDb();

      // 模拟真实损坏形态（与历史 pglite.corrupted.* 目录一致）：PG_VERSION
      // 保留，删 global/pg_control → 启动 Aborted()（upstream #884）。
      // 注意不能用删除 PG_VERSION 模拟：PGlite 会据此静默重跑 initdb，
      // 反而破坏损坏目录（见 preflightDataDir 的注释）。
      const dataDir = getPgliteDataDir();
      await fsp.rm(path.join(dataDir, 'global', 'pg_control'));

      // 重新加载模块（新进程语义）：启动失败 → 自动从备份恢复
      vi.resetModules();
      const fresh = await import('../../../src/db/drizzle');
      await fresh.ensureDbReady();

      const rows = await fresh.getPglite().query<{ id: number }>(
        'SELECT * FROM recovery_probe',
      );
      expect(rows.rows.length).toBe(1);

      // 损坏目录被移走保留（forensics 约定）
      const parent = path.dirname(dataDir);
      const asides = (await fsp.readdir(parent)).filter((n) =>
        n.startsWith(`${path.basename(dataDir)}.corrupted.`),
      );
      expect(asides.length).toBeGreaterThan(0);

      await fresh.closeDb();
    },
  );
});
