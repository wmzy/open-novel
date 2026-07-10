import { describe, it, expect } from 'vitest';
import {
  WRITING_SUBAGENTS,
  getSubagentGuidance,
} from '../../../src/agent/subagents';

/** state-patcher 现在负责更新的全部状态追踪文件（职责分离后）。 */
const STATE_PATCHER_FILES = [
  '.novel/chapters/第N章.summary.md',
  '.novel/character-states.md',
  '.novel/progress.md',
  '.novel/state.json',
  '.novel/foreshadow.json',
];

describe('WRITING_SUBAGENTS', () => {
  it('包含 chapter-reviewer 与 state-patcher 两个角色', () => {
    const names = WRITING_SUBAGENTS.map((a) => a.name);
    expect(names).toContain('chapter-reviewer');
    expect(names).toContain('state-patcher');
  });

  describe('state-patcher systemPrompt（多文件职责）', () => {
    const patcher = WRITING_SUBAGENTS.find((a) => a.name === 'state-patcher')!;

    it('description 反映全部状态追踪文件', () => {
      expect(patcher.description).toContain('章节摘要');
      expect(patcher.description).toContain('角色状态');
      expect(patcher.description).toContain('写作进度');
      expect(patcher.description).toContain('伏笔追踪');
    });

    it('systemPrompt 按顺序列出五项职责', () => {
      // 五项职责标题必须存在
      expect(patcher.systemPrompt).toContain('1. **生成章节摘要**');
      expect(patcher.systemPrompt).toContain('2. **更新角色状态**');
      expect(patcher.systemPrompt).toContain('3. **更新写作进度**');
      expect(patcher.systemPrompt).toContain('4. **更新结构化状态**');
      expect(patcher.systemPrompt).toContain('5. **更新伏笔追踪**');
    });

    it('systemPrompt 涵盖全部五个状态文件', () => {
      for (const file of STATE_PATCHER_FILES) {
        expect(patcher.systemPrompt).toContain(file);
      }
    });

    it('state.json 仅保留结构化字段，不含角色详细状态', () => {
      expect(patcher.systemPrompt).toContain('lastUpdatedChapter');
      expect(patcher.systemPrompt).toContain('timeline');
      expect(patcher.systemPrompt).toContain('activeForeshadows');
      // 角色详细状态不再写入 state.json
      expect(patcher.systemPrompt).toContain(
        '角色详细状态不要再写入 state.json',
      );
    });

    it('保留 foreshadow.json 标准 schema 指导', () => {
      // schema 严格化：顶层键、字段名、status 取值
      expect(patcher.systemPrompt).toContain('顶层键为 foreshadows');
      expect(patcher.systemPrompt).toContain('内容字段为 content');
      expect(patcher.systemPrompt).toContain('pending/planted/resolved');
    });

    it('摘要严禁复制正文原文', () => {
      expect(patcher.systemPrompt).toContain('严禁复制正文原文段落');
    });
  });
});

describe('getSubagentGuidance', () => {
  it('未指定 agentId 返回空串', () => {
    expect(getSubagentGuidance(undefined)).toBe('');
    expect(getSubagentGuidance('')).toBe('');
  });

  describe('CC / OMP（支持 SubAgent 委托）', () => {
    it('claude 用 Agent 工具', () => {
      const g = getSubagentGuidance('claude');
      expect(g).toContain('Agent 工具');
      expect(g).not.toContain('task 工具');
    });

    it('omp 用 task 工具', () => {
      const g = getSubagentGuidance('omp');
      expect(g).toContain('task 工具');
    });

    it('state-patcher 指导列出全部五个状态文件', () => {
      const g = getSubagentGuidance('omp');
      expect(g).toContain('### state-patcher（状态更新）');
      expect(g).toContain('**何时委托**：章节正文写完并保存后');
      for (const file of STATE_PATCHER_FILES) {
        expect(g).toContain(file);
      }
    });

    it('chapter-reviewer 指导保留', () => {
      const g = getSubagentGuidance('omp');
      expect(g).toContain('### chapter-reviewer（审稿）');
    });
  });

  describe('OpenCode（不支持 SubAgent，内联指导）', () => {
    const g = getSubagentGuidance('opencode');

    it('声明不支持 SubAgent 委托', () => {
      expect(g).toContain('不支持 SubAgent 委托');
      expect(g).toContain('不要委托');
    });

    it('内联列出全部五个状态文件（自行完成）', () => {
      for (const file of STATE_PATCHER_FILES) {
        expect(g).toContain(file);
      }
    });

    it('强调正文与状态更新分离', () => {
      expect(g).toContain('正文与状态更新分离');
      expect(g).toContain('先把整章正文写完保存');
    });
  });
});

