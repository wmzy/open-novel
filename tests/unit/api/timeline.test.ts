import { describe, it, expect } from 'vitest';
import { replaceChapterInteraction, extractChapterField } from '../../../src/api/routes/timeline';

describe('replaceChapterInteraction', () => {
  const CHAPTER = `## 第 1 章：测试 ｜ 第一幕·设置
- **POV**：武松
- **出场角色**：武松、何九叔
- **核心事件**：test`;

  it('已有角色交互 bullet 时替换', () => {
    const withInteraction = CHAPTER + '\n- **角色交互**：旧的';
    const result = replaceChapterInteraction(withInteraction, '新的交互');
    expect(result).toContain('新的交互');
    expect(result).not.toContain('旧的');
  });

  it('无角色交互 bullet 时在出场角色行后插入', () => {
    const result = replaceChapterInteraction(CHAPTER, 'A→B[冲突]：x');
    expect(result).toContain('- **角色交互**：A→B[冲突]：x');
    const lines = result!.split('\n');
    const castIdx = lines.findIndex((l) => l.includes('出场角色'));
    const interactionIdx = lines.findIndex((l) => l.includes('角色交互'));
    expect(interactionIdx).toBe(castIdx + 1);
  });

  it('表格格式：替换已有角色交互行', () => {
    const tableChapter = `#### 第1章：测试
| POV | 武松 |
| 出场角色 | 武松、何九叔 |
| 角色交互 | 旧的 |`;
    const result = replaceChapterInteraction(tableChapter, '新的');
    expect(result).toContain('| 角色交互 | 新的 |');
    expect(result).not.toContain('旧的');
  });

  it('表格格式：无角色交互行时在出场角色行后插入', () => {
    const tableChapter = `#### 第1章：测试
| POV | 武松 |
| 出场角色 | 武松、何九叔 |`;
    const result = replaceChapterInteraction(tableChapter, 'X→Y[对话]：z');
    expect(result).toContain('| 角色交互 | X→Y[对话]：z |');
  });

  it('无出场角色行时追加到末尾', () => {
    const minimal = `## 第 2 章：无角\n- **POV**：武松`;
    const result = replaceChapterInteraction(minimal, 'X→Y[对话]：z');
    expect(result).toContain('角色交互');
  });
});

describe('extractChapterField', () => {
  it('提取表格格式字段', () => {
    const content = `#### 第1章：测试\n| POV | 武松 |\n| 核心事件 | 下山 |`;
    expect(extractChapterField(content, '核心事件')).toBe('下山');
    expect(extractChapterField(content, 'POV')).toBe('武松');
  });

  it('提取 bullet 格式字段', () => {
    const content = `## 第 1 章\n- **POV**：武松\n- **核心事件**：下山`;
    expect(extractChapterField(content, '核心事件')).toBe('下山');
    expect(extractChapterField(content, 'POV')).toBe('武松');
  });

  it('字段不存在返回空串', () => {
    const content = `## 第 1 章\n- **POV**：武松`;
    expect(extractChapterField(content, '角色交互')).toBe('');
  });
});
