import { describe, it, expect } from 'vitest';
import { replaceChapterInteraction } from '../../../src/api/routes/timeline';

describe('replaceChapterInteraction', () => {
  const OUTLINE = `#### 第1章：测试
| 项目 | 内容 |
|------|------|
| POV | 武松 |
| 出场角色 | 武松、何九叔 |
| 核心事件 | test |`;

  it('已有角色交互行时替换', () => {
    const withInteraction = OUTLINE + '\n| 角色交互 | 旧的 |';
    const result = replaceChapterInteraction(withInteraction, 1, '新的交互');
    expect(result).toContain('新的交互');
    expect(result).not.toContain('旧的');
  });

  it('无角色交互行时在出场角色行后插入', () => {
    const result = replaceChapterInteraction(OUTLINE, 1, 'A→B[冲突]：x');
    expect(result).toContain('| 角色交互 | A→B[冲突]：x |');
    // 插入在出场角色行之后
    const lines = result!.split('\n');
    const castIdx = lines.findIndex((l) => l.includes('出场角色'));
    const interactionIdx = lines.findIndex((l) => l.includes('角色交互'));
    expect(interactionIdx).toBe(castIdx + 1);
  });

  it('章号不存在返回 null', () => {
    expect(replaceChapterInteraction(OUTLINE, 99, 'x')).toBeNull();
  });

  it('无出场角色行但有其他表格行时追加到表格末尾', () => {
    const noCast = `#### 第2章：无角\n| 项目 | 内容 |\n|------|------|\n| POV | 武松 |`;
    const result = replaceChapterInteraction(noCast, 2, 'X→Y[对话]：z');
    expect(result).toContain('| 角色交互 | X→Y[对话]：z |');
  });
});
