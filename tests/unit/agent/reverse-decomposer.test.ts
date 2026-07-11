import { describe, it, expect } from 'vitest';
import { buildReverseDecomposePrompt } from '../../../src/agent/reverse-decomposer';

describe('buildReverseDecomposePrompt', () => {
  const baseMeta = { projectDir: '/home/user/novels/book', chapterCount: 10 };

  it('包含五步指令', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('第一步');
    expect(prompt).toContain('第二步');
    expect(prompt).toContain('第三步');
    expect(prompt).toContain('第四步');
    expect(prompt).toContain('第五步');
  });

  it('注入正确章节文件路径与章数', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('chapters/第N章.md');
    expect(prompt).toContain('共 10 章');
  });

  it('无 title/genre 时省略提示', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).not.toContain('参考标题');
    expect(prompt).not.toContain('参考类型');
  });

  it('有 title/genre 时注入参考提示', () => {
    const prompt = buildReverseDecomposePrompt({ ...baseMeta, title: '示例', genre: 'wuxia' });
    expect(prompt).toContain('参考标题');
    expect(prompt).toContain('示例');
  });

  it('指令写入 state.json 的 relationships 字段', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('relationships');
    expect(prompt).toContain('state.json');
  });

  it('指令写入 outline/chapters/ 的表格格式', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('outline/chapters/');
    expect(prompt).toContain('POV');
    expect(prompt).toContain('核心事件');
    expect(prompt).toContain('出场角色');
  });

  it('指令写入滚动摘要', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('第N章.summary.md');
  });
});
