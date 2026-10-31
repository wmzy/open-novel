// @vitest-environment node
/**
 * 随包只读资源解析：npx/全局安装时 process.cwd() 是用户目录，模板/插件/migration
 * 必须相对包根解析。这里直接验证 package root 与三个资源目录，并用伪造 cwd
 * 证明 initPlugins 不再依赖启动目录。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  packageMigrationsDir,
  packagePluginsDir,
  packageRoot,
  packageTemplatesDir,
} from '../../../src/shared/package-root';
import { getPlugins, initPlugins } from '../../../src/plugins/registry';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // 还原全局 plugin registry，避免影响同 worker 的其它文件。
  initPlugins();
});

describe('package-root', () => {
  it('定位到含 package.json 的包根', () => {
    const root = packageRoot();
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'templates', 'CREATOR.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'plugins', 'novel', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'drizzle', 'meta', '_journal.json'))).toBe(true);
  });

  it('OPEN_NOVEL_PACKAGE_ROOT 显式覆盖', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-novel-root-'));
    try {
      vi.stubEnv('OPEN_NOVEL_PACKAGE_ROOT', tmp);
      expect(packageRoot()).toBe(path.resolve(tmp));
      expect(packageTemplatesDir()).toBe(path.join(path.resolve(tmp), 'templates'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('DRIZZLE_MIGRATIONS_FOLDER 仍可覆盖 migration 目录', () => {
    vi.stubEnv('DRIZZLE_MIGRATIONS_FOLDER', '/tmp/custom-migrations');
    expect(packageMigrationsDir()).toBe('/tmp/custom-migrations');
  });

  it('initPlugins 不依赖 process.cwd()', () => {
    const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'open-novel-cwd-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
      initPlugins();
      const ids = getPlugins().map((p) => p.id);
      expect(ids).toContain('novel');
      expect(ids).toContain('wuxia');
    } finally {
      fs.rmSync(fakeCwd, { recursive: true, force: true });
    }
  });

  it('三个资源目录都位于包根下', () => {
    const root = packageRoot();
    expect(packagePluginsDir()).toBe(path.join(root, 'plugins'));
    expect(packageTemplatesDir()).toBe(path.join(root, 'templates'));
    expect(packageMigrationsDir()).toBe(path.join(root, 'drizzle'));
  });
});
