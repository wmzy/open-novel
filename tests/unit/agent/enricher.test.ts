import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { buildEnrichPrompt } from '../../../src/agent/enricher';
import { initPlugins } from '../../../src/plugins/registry';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * buildEnrichPrompt：补全缺失结构化数据的 agent 指令构建器。
 * 与 buildReverseDecomposePrompt（/import）同构，差异是输入源为已有结构化文件而非正文，
 * 且严格"只增不覆盖"——保护用户已有劳动成果。
 */
describe('buildEnrichPrompt', () => {
  const meta = { projectDir: '/tmp/test-novel' };

  it('包含项目目录路径', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toContain('/tmp/test-novel');
  });

  it('声明"只增不覆盖"核心约束', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toContain('只增不覆盖');
    expect(prompt).toMatch(/绝不修改|绝不覆盖/);
  });

  it('包含 outline-meta.json 补全步骤（从大纲 POV 表提取）', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toContain('outline-meta.json');
    expect(prompt).toContain('POV');
    expect(prompt).toContain('outline/chapters/');
  });

  it('包含 state.json 补全步骤（角色状态 + relationships）', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toContain('state.json');
    expect(prompt).toContain('relationships');
  });

  it('relationships 反推优先从角色关系图提取', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toContain('角色关系图');
  });

  it('章节摘要仅在存在正文时生成（无正文则跳过）', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toContain('summary');
    expect(prompt).toMatch(/无.*正文|仅有大纲|跳过/);
  });

  it('完成后报告创建/跳过了哪些文件', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toMatch(/报告|列出/);
    expect(prompt).toContain('跳过');
  });

  it('限制 agent 只能访问项目目录内', () => {
    const prompt = buildEnrichPrompt(meta);
    expect(prompt).toMatch(/绝不访问.*之外|项目目录.*内/);
  });

  describe('模板维度补充（skillId 驱动）', () => {
    let tmpDir: string;

    beforeAll(() => initPlugins());

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-dim-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('无 skillId 时不包含维度补充步骤', () => {
      const prompt = buildEnrichPrompt({ projectDir: tmpDir });
      expect(prompt).not.toContain('第五步·模板维度补充');
      expect(prompt).not.toContain('追加到对应文件末尾');
    });

    it('检测到缺失 ## 维度节时，prompt 包含第五步并列出缺失节', () => {
      // 模拟旧项目：world-building.md 只有部分节
      fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.novel', 'world-building.md'),
        '# 世界观设定\n\n## 时代背景\n南宋。\n\n## 武功体系\n内功。\n',
      );

      const prompt = buildEnrichPrompt({ projectDir: tmpDir, skillId: 'wuxia' });
      expect(prompt).toContain('第五步');
      expect(prompt).toContain('模板维度补充');
      // wuxia 模板有 10 个 ## 节，项目只写了 2 个，缺失至少含经济/情报
      expect(prompt).toMatch(/江湖经济|情报网络|阵法/);
    });
  });
});
