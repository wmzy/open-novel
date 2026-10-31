/**
 * 发布前包内容检查脚本（scripts/verify-package-contents.mjs）。
 *
 * 关键行为：npm 包缺少 dist/启动器/插件/模板/migration 任一项即失败——
 * 发布一个装不起来的空壳包比不发布更糟。
 */
import { describe, it, expect } from 'vitest';
import {
  REQUIRED,
  findMissing,
  parsePackJson,
  verify,
} from '../../../scripts/verify-package-contents.mjs';

const COMPLETE_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'bin/open-novel.mjs',
  'dist/client/index.html',
  'dist/server/api.js',
  'plugins/novel/SKILL.md',
  'plugins/wuxia/SKILL.md',
  'templates/CREATOR.md',
  'templates/progress.md',
  'templates/character-states.md',
  'templates/styles/README.md',
  'drizzle/meta/_journal.json',
  'drizzle/0000_init.sql',
];

describe('verify-package-contents', () => {
  it('完整包通过检查', async () => {
    const raw = JSON.stringify([{ filename: 'pkg.tgz', files: COMPLETE_FILES.map((p) => ({ path: p })) }]);
    const result = await verify(raw);
    expect(result.filename).toBe('pkg.tgz');
    expect(result.fileCount).toBe(COMPLETE_FILES.length);
  });

  it('缺少 templates / drizzle 等资源时报出具体缺项', async () => {
    const incomplete = COMPLETE_FILES.filter((p) => !p.startsWith('templates/') && !p.startsWith('drizzle/'));
    const raw = JSON.stringify([{ filename: 'pkg.tgz', files: incomplete.map((p) => ({ path: p })) }]);
    await expect(verify(raw)).rejects.toThrow(/templates\/CREATOR\.md/);
    const missing = findMissing(incomplete);
    expect(missing).toContain('templates/CREATOR.md');
    expect(missing).toContain('drizzle');
  });

  it('缺少 dist 产物时报错（空壳包不得发布）', async () => {
    const raw = JSON.stringify([{ files: [{ path: 'package.json' }] }]);
    await expect(verify(raw)).rejects.toThrow(/dist\/client\/index\.html/);
  });

  it('输出格式非法时抛出明确错误', () => {
    expect(() => parsePackJson('')).toThrow(/未读到 npm pack 输出/);
    expect(() => parsePackJson('[]')).toThrow(/没有 files 列表/);
    expect(() => parsePackJson('not json')).toThrow();
  });

  it('REQUIRED 覆盖构建产物、启动器、插件、模板与 migration', () => {
    for (const key of ['dist/client/index.html', 'bin/open-novel.mjs', 'plugins/novel/SKILL.md', 'templates/CREATOR.md', 'drizzle']) {
      expect(REQUIRED).toContain(key);
    }
  });
});
