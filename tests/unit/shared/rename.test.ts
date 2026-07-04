import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performRename, findSubstringConflicts } from '../../../src/shared/rename';

describe('findSubstringConflicts', () => {
  it('检测 oldName 是其他全名子串的情况', () => {
    const allNames = ['宋江', '宋清', '林冲', '吴用'];
    const conflicts = findSubstringConflicts('沈', allNames);
    expect(conflicts).toEqual(['宋江', '宋清']);
  });

  it('oldName 是精确全名时无冲突', () => {
    const allNames = ['宋江', '宋清', '林冲'];
    const conflicts = findSubstringConflicts('宋江', allNames);
    expect(conflicts).toEqual([]);
  });

  it('空名字列表返回空', () => {
    expect(findSubstringConflicts('沈', [])).toEqual([]);
  });
});

describe('performRename', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-test-'));
    // 模拟 .novel 结构
    const novelDir = path.join(tempDir, '.novel');
    await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
    await fs.mkdir(path.join(novelDir, 'characters'), { recursive: true });
    await fs.writeFile(
      path.join(novelDir, 'characters', 'profiles.md'),
      '## 一、宋清（主角）\n\n宋清站在破庙前。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第1章.md'),
      '# 第一章\n\n宋清推开了门。宋清看见师父。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第2章.md'),
      '# 第二章\n\n这一章没有主角出场。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'state.json'),
      JSON.stringify({
        characters: [{ name: '宋清', role: '主角' }],
        timeline: '宋清到达衡山',
        lastUpdatedChapter: 1,
        updatedAt: '2026-01-01',
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('精确全名替换到所有匹配文件', async () => {
    const result = await performRename(tempDir, '宋清', '林寒声');
    expect(result.filesModified).toBe(3); // profiles.md + 第1章.md + state.json
    // profiles 2 + 第1章 2 + state 2 (name + timeline)
    expect(result.totalReplacements).toBe(6);

    const ch1 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第1章.md'), 'utf-8');
    expect(ch1).toContain('林寒声');
    expect(ch1).not.toContain('宋清');

    const ch2 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第2章.md'), 'utf-8');
    expect(ch2).not.toContain('林寒声'); // 未出场文件不被修改

    const state = JSON.parse(await fs.readFile(path.join(tempDir, '.novel', 'state.json'), 'utf-8'));
    expect(state.characters[0].name).toBe('林寒声');
  });

  it('scope 限定只替换指定文件', async () => {
    const result = await performRename(tempDir, '宋清', '林寒声', {
      scope: ['.novel/characters/profiles.md'],
    });
    expect(result.filesModified).toBe(1);

    const ch1 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第1章.md'), 'utf-8');
    expect(ch1).toContain('宋清'); // 未在 scope 中，不变
  });

  it('无匹配时 filesModified=0', async () => {
    const result = await performRename(tempDir, '不存在的人', '某人');
    expect(result.filesModified).toBe(0);
    expect(result.totalReplacements).toBe(0);
  });
});
