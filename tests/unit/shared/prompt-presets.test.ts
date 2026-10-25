import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listPresets,
  getPreset,
  getPresetDetail,
  createPreset,
  addVersion,
  setCurrentVersion,
  renamePreset,
  deletePreset,
  getStageBindings,
  setStageBinding,
  resolveActivePresetPrompt,
  importFromSkillFile,
  stripSkillFrontmatter,
} from '../../../src/shared/prompt-presets';

let tmpDir: string;
const root = () => path.join(tmpDir, '.novel', 'prompt-presets');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-presets-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createPreset / listPresets / getPreset', () => {
  it('中文名缺省 id 走拼音 slug，v1 落盘且 manifest current=1', async () => {
    const manifest = await createPreset(tmpDir, {
      name: '武侠文风',
      content: '多用短句，重意境。',
    });
    expect(manifest.id).toBe('wuxiawenfeng');
    expect(manifest.current).toBe(1);
    expect(manifest.versions).toHaveLength(1);
    expect(manifest.versions[0]).toMatchObject({ version: 1, file: 'v1.md' });

    // v1.md 内容落盘（写入统一追加换行）
    const file = fs.readFileSync(path.join(root(), manifest.id, 'v1.md'), 'utf-8');
    expect(file.trim()).toBe('多用短句，重意境。');

    const list = await listPresets(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'wuxiawenfeng', current: 1, versionCount: 1, stage: '' });

    expect(await getPreset(tmpDir, 'wuxiawenfeng')).not.toBeNull();
    expect(await getPreset(tmpDir, 'nope')).toBeNull();
  });

  it('显式 id 可用；重复 id 与非法 id 报错（防路径穿越）', async () => {
    await createPreset(tmpDir, { id: 'my-style', name: 'A', content: 'x' });
    await expect(createPreset(tmpDir, { id: 'my-style', name: 'B', content: 'y' }))
      .rejects.toThrow('预设 id 已存在');
    await expect(createPreset(tmpDir, { id: '../evil', name: 'C', content: 'z' }))
      .rejects.toThrow('预设 id');
    await expect(createPreset(tmpDir, { id: 'UPPER', name: 'D', content: 'z' }))
      .rejects.toThrow('预设 id');
  });

  it('自动 slug 撞名时追加 -2 序号', async () => {
    const a = await createPreset(tmpDir, { name: '文风', content: 'x' });
    const b = await createPreset(tmpDir, { name: '文风', content: 'y' });
    expect(a.id).toBe('wenfeng');
    expect(b.id).toBe('wenfeng-2');
    expect((await listPresets(tmpDir)).map((p) => p.id).sort()).toEqual(['wenfeng', 'wenfeng-2']);
  });

  it('名称 / 内容为空报错', async () => {
    await expect(createPreset(tmpDir, { name: '', content: 'x' })).rejects.toThrow('名称');
    await expect(createPreset(tmpDir, { name: 'A', content: '  ' })).rejects.toThrow('内容');
  });
});

describe('版本 append-only 语义', () => {
  it('addVersion 自增版本号并把 current 指向新版，旧版本文件仍在且可读', async () => {
    const { id } = await createPreset(tmpDir, { name: 'A', content: '第一版内容' });
    const v2 = await addVersion(tmpDir, id, { content: '第二版内容', note: '加强文风' });
    expect(v2).toMatchObject({ version: 2, file: 'v2.md', note: '加强文风' });

    const manifest = await getPreset(tmpDir, id);
    expect(manifest?.current).toBe(2);
    expect(manifest?.versions.map((v) => v.version)).toEqual([1, 2]);

    // append-only：v1.md 未被改写/删除
    expect(fs.existsSync(path.join(root(), id, 'v1.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root(), id, 'v1.md'), 'utf-8').trim()).toBe('第一版内容');
    expect(fs.readFileSync(path.join(root(), id, 'v2.md'), 'utf-8').trim()).toBe('第二版内容');

    const detail = await getPresetDetail(tmpDir, id);
    expect(detail?.versions.map((v) => v.content.trim())).toEqual(['第一版内容', '第二版内容']);
  });

  it('setCurrentVersion 只改 current 指针，不动任何版本文件', async () => {
    const { id } = await createPreset(tmpDir, { name: 'A', content: 'v1' });
    await addVersion(tmpDir, id, { content: 'v2' });
    await addVersion(tmpDir, id, { content: 'v3' });

    const updated = await setCurrentVersion(tmpDir, id, 1);
    expect(updated.current).toBe(1);
    // 三个版本文件全部健在（append-only）
    for (const f of ['v1.md', 'v2.md', 'v3.md']) {
      expect(fs.existsSync(path.join(root(), id, f))).toBe(true);
    }
    // 切到不存在的版本报错并列出可用版本
    await expect(setCurrentVersion(tmpDir, id, 99)).rejects.toThrow('版本不存在');
  });

  it('renamePreset 改名；对不存在的预设操作报错', async () => {
    const { id } = await createPreset(tmpDir, { name: '旧名', content: 'x' });
    const updated = await renamePreset(tmpDir, id, '新名');
    expect(updated.name).toBe('新名');
    await expect(renamePreset(tmpDir, 'nope', 'x')).rejects.toThrow('预设不存在');
  });
});

describe('阶段绑定 bindings.json', () => {
  it('set/get 往返；null 清空；非法阶段与不存在的预设报错', async () => {
    const { id } = await createPreset(tmpDir, { name: 'A', content: 'x' });
    const bindings = await setStageBinding(tmpDir, 'writing', id);
    expect(bindings.writing).toBe(id);
    expect((await getStageBindings(tmpDir)).writing).toBe(id);

    await setStageBinding(tmpDir, 'outline', null);
    expect((await getStageBindings(tmpDir)).outline).toBeNull();

    await expect(setStageBinding(tmpDir, 'not-a-stage', id)).rejects.toThrow('未知阶段');
    await expect(setStageBinding(tmpDir, 'writing', 'ghost')).rejects.toThrow('预设不存在');
  });

  it('deletePreset 删除整个目录并清理指向它的绑定', async () => {
    const { id } = await createPreset(tmpDir, { name: 'A', content: 'x' });
    await setStageBinding(tmpDir, 'writing', id);
    await setStageBinding(tmpDir, 'sample', id);

    await deletePreset(tmpDir, id);
    expect(fs.existsSync(path.join(root(), id))).toBe(false);
    expect(await getPreset(tmpDir, id)).toBeNull();
    const bindings = await getStageBindings(tmpDir);
    expect(bindings.writing).toBeNull();
    expect(bindings.sample).toBeNull();
    await expect(deletePreset(tmpDir, id)).rejects.toThrow('预设不存在');
  });
});

describe('resolveActivePresetPrompt', () => {
  it('未绑定返回 null；绑定后返回 current 版本内容；切版本后内容跟随', async () => {
    expect(await resolveActivePresetPrompt(tmpDir, 'writing')).toBeNull();

    const { id } = await createPreset(tmpDir, { name: '文风', content: '第一版' });
    await setStageBinding(tmpDir, 'writing', id);

    const active = await resolveActivePresetPrompt(tmpDir, 'writing');
    expect(active).toMatchObject({ presetId: id, version: 1, content: '第一版' });

    await addVersion(tmpDir, id, { content: '第二版' });
    expect(await resolveActivePresetPrompt(tmpDir, 'writing')).toMatchObject({ version: 2, content: '第二版' });

    await setCurrentVersion(tmpDir, id, 1);
    expect(await resolveActivePresetPrompt(tmpDir, 'writing')).toMatchObject({ version: 1, content: '第一版' });
  });

  it('绑定指向已删除预设（悬空）时返回 null 而非抛错', async () => {
    const { id } = await createPreset(tmpDir, { name: 'A', content: 'x' });
    await setStageBinding(tmpDir, 'writing', id);
    await deletePreset(tmpDir, id);
    // deletePreset 会清理绑定；这里手动塞回悬空绑定模拟外部改动
    fs.writeFileSync(
      path.join(root(), 'bindings.json'),
      JSON.stringify({ writing: id }),
    );
    expect(await resolveActivePresetPrompt(tmpDir, 'writing')).toBeNull();
  });
});

describe('importFromSkillFile', () => {
  function writeSkill(dir: string, content: string, withManifest?: unknown) {
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillPath, content);
    if (withManifest !== undefined) {
      fs.writeFileSync(path.join(dir, 'open-novel.json'), JSON.stringify(withManifest));
    }
    return skillPath;
  }

  it('剥离 YAML frontmatter，正文入库为 v1', async () => {
    const skillPath = writeSkill(path.join(tmpDir, 'plugin-a'), [
      '---',
      'name: wuxia-skill',
      'description: 武侠写作技能',
      '---',
      '以金庸笔法为准。',
      '',
    ].join('\n'));

    const manifest = await importFromSkillFile(tmpDir, { skillPath });
    expect(manifest.stage).toBe('');
    // 名称缺省取 frontmatter name
    expect(manifest.name).toBe('wuxia-skill');
    expect(manifest.description).toContain(skillPath);
    const detail = await getPresetDetail(tmpDir, manifest.id);
    expect(detail?.versions[0]?.content.trim()).toBe('以金庸笔法为准。');
  });

  it('同目录 open-novel.json 的 stages 佐证阶段（未显式给 stage 时取交集第一个）', async () => {
    const skillPath = writeSkill(
      path.join(tmpDir, 'plugin-b'),
      '正文',
      { id: 'b', name: 'B', stages: ['outline', 'writing'] },
    );
    const manifest = await importFromSkillFile(tmpDir, { skillPath, stage: 'outline' });
    expect(manifest.stage).toBe('outline');

    const manifest2 = await importFromSkillFile(tmpDir, { skillPath, name: 'B2' });
    expect(manifest2.stage).toBe('outline'); // 交集第一个（stages 顺序）
  });

  it('无 frontmatter / 空 body / 非 md / 相对路径 / 不存在文件的处理', async () => {
    // 无 frontmatter：名称取文件名
    const plain = writeSkill(path.join(tmpDir, 'plugin-c'), '普通正文');
    const m = await importFromSkillFile(tmpDir, { skillPath: plain });
    expect(m.name).toBe('SKILL');
    expect((await getPresetDetail(tmpDir, m.id))?.versions[0].content.trim()).toBe('普通正文');

    // 只有 frontmatter 没正文 → 报错
    const empty = writeSkill(path.join(tmpDir, 'plugin-d'), '---\nname: x\n---\n');
    await expect(importFromSkillFile(tmpDir, { skillPath: empty })).rejects.toThrow('正文为空');

    await expect(importFromSkillFile(tmpDir, { skillPath: 'relative/SKILL.md' }))
      .rejects.toThrow('绝对路径');
    await expect(importFromSkillFile(tmpDir, { skillPath: path.join(tmpDir, 'SKILL.txt') }))
      .rejects.toThrow('.md');
    await expect(importFromSkillFile(tmpDir, { skillPath: path.join(tmpDir, 'nope.md') }))
      .rejects.toThrow('不存在');
  });
});

describe('stripSkillFrontmatter', () => {
  it('无 frontmatter 原样返回；有则剥离', () => {
    expect(stripSkillFrontmatter('正文')).toBe('正文');
    expect(stripSkillFrontmatter('---\nname: x\n---\n正文')).toBe('正文');
    // 开头的 --- 不构成闭合块时不应误剥
    expect(stripSkillFrontmatter('---\n只有一条横线开头')).toBe('---\n只有一条横线开头');
  });
});
