import { describe, it, expect } from 'vitest';
import { buildEnrichPrompt } from '../../../src/agent/enricher';

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
    expect(prompt).toContain('outline-detailed.md');
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
});
