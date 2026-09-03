/**
 * src/db/backup.ts 变更检测（WAL LSN）单元测试。
 *
 * 来源：修复「数据库无变更时仍创建新备份副本」。
 * 归并建议：与 drizzle.test.ts 同属 db 层单元测试，保留在 tests/unit/db/ 下即可。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDataDir, listBackups } from '../../../src/db/backup';
import { getPglite } from '../../../src/db/drizzle';

describe('backupDataDir 变更检测', () => {
  beforeAll(async () => {
    await getPglite().waitReady;
  });

  afterAll(async () => {
    await getPglite().close();
  });

  it('首次备份创建新文件', async () => {
    const result = await backupDataDir();
    expect(result.created).toBe(true);
    if (result.created) {
      const backups = await listBackups();
      expect(backups.length).toBe(1);
      expect(backups[0].filename).toBe(result.filepath.split('/').pop());
    }
  });

  it('无变更时跳过，不创建新副本', async () => {
    const first = await backupDataDir();
    expect(first.created).toBe(false);
    expect(first.filepath).toBeTruthy();

    const backups = await listBackups();
    expect(backups.length).toBe(1);
  });

  it('数据写入后创建新副本', async () => {
    const before = await backupDataDir();
    const beforePath = before.filepath;

    // 任意写入都会推进 WAL LSN
    await getPglite().query('CREATE TABLE IF NOT EXISTS backup_test (id int)');
    await getPglite().query('INSERT INTO backup_test VALUES (1)');

    const after = await backupDataDir();
    expect(after.created).toBe(true);
    expect(after.filepath).not.toBe(beforePath);

    const backups = await listBackups();
    expect(backups.length).toBe(2);
  });

  it('最新备份文件被删除后不再跳过', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const backups = await listBackups();
    const newest = backups[0];
    const fullPath = path.join(process.env.BACKUP_DIR!, newest.filename);
    await fs.unlink(fullPath);

    const result = await backupDataDir();
    expect(result.created).toBe(true);
  });
});
