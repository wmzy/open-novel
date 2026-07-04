import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// vi.hoisted keeps mock refs available inside hoisted vi.mock factories.
const { mockLimit, mockGetPlugin } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  mockGetPlugin: vi.fn(),
}));

// Mock db: composePrompt does db.select().from(projects).where(eq(...)).limit(1)
// returning Promise<project[]>. Only limit()'s resolved value matters.
vi.mock('../../../src/db/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) }),
  },
}));

vi.mock('../../../src/plugins/registry', () => ({
  getPlugin: mockGetPlugin,
}));

// Import AFTER mocks are registered.
const { composePrompt } = await import('../../../src/agent/prompt-composer');

// 用于识别各阶段指令的特征文本（STAGE_INSTRUCTIONS 的首句片段）。
const STAGE_FEATURES: Record<string, string> = {
  concept: '聚焦于构思核心概念',
  world: '构建故事世界',
  characters: '撰写详细的角色档案',
  outline: '创建详细的故事大纲',
  scenes: '将大纲拆解为详细场景',
  writing: '为小说撰写真正的散文正文',
  drafting: '为小说撰写真正的散文正文',
  revision: '审阅和改进已有内容',
  polish: '最终润色',
};

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj_test',
    title: 'Test Novel',
    path: '/tmp/test',
    genre: 'fantasy',
    targetWords: 80000,
    chapterCount: 15,
    theme: 'redemption',
    perspective: 'first-person',
    currentStage: 'concept',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedProjectFiles(dir: string) {
  await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });
  await fs.writeFile(path.join(dir, '.novel', 'concept.md'), '# Concept');
  await fs.writeFile(path.join(dir, '.novel', 'chapters', 'ch1.md'), 'chapter 1');
  await fs.writeFile(path.join(dir, '.novel', 'config.json'), '{}');
}

describe('composePrompt', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-prompt-'));
    mockLimit.mockResolvedValue([]);
    mockGetPlugin.mockReturnValue(null);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('stage instruction injection', () => {
    for (const [stage, feature] of Object.entries(STAGE_FEATURES)) {
      it(`injects ${stage} stage instructions`, async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage,
          projectDir: tempDir,
        });
        expect(prompt).toContain(`## Current Stage: ${stage}`);
        expect(prompt).toContain(feature);
      });
    }

    it('falls back for an unknown stage', async () => {
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        stage: 'custom',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## Current Stage: custom');
      expect(prompt).toContain('着手推进小说项目的「custom」阶段');
    });

    it('defaults to concept stage when stage is undefined', async () => {
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## Current Stage: concept');
      expect(prompt).toContain(STAGE_FEATURES.concept);
    });
  });

  describe('project context', () => {
    it('injects formatted project metadata', async () => {
      const project = makeProject({
        title: 'My Epic',
        genre: 'scifi',
        theme: 'AI awakening',
        perspective: 'second-person',
        targetWords: 123456,
        chapterCount: 42,
        currentStage: 'writing',
      });
      mockLimit.mockResolvedValue([project]);

      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      expect(prompt).toContain('Project: My Epic');
      expect(prompt).toContain('Genre: scifi');
      expect(prompt).toContain('Theme: AI awakening');
      expect(prompt).toContain('Perspective: second-person');
      expect(prompt).toContain('Target word count: 123456');
      expect(prompt).toContain('Chapter count: 42');
      expect(prompt).toContain('Current stage: writing');
    });

    it('uses blank context when DB returns empty (not an error)', async () => {
      mockLimit.mockResolvedValue([]);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      // Empty result is not an error: context stays blank — no fallback message, no metadata.
      expect(prompt).not.toContain('Project metadata unavailable.');
      expect(prompt).not.toContain('Project: ');
    });

    it('falls back without crashing when DB rejects', async () => {
      mockLimit.mockRejectedValue(new Error('connection lost'));
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      expect(prompt).toContain('Project metadata unavailable.');
    });
  });

  describe('project files', () => {
    it('lists existing .md/.json files under .novel/', async () => {
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## Project Files');
      expect(prompt).toContain('.novel/concept.md');
      expect(prompt).toContain('.novel/chapters/ch1.md');
      expect(prompt).toContain('.novel/config.json');
    });

    it('omits the files section when directory has no .novel/', async () => {
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## Project Files');
    });
  });

  describe('skill content', () => {
    it('injects skill instructions when plugin exists', async () => {
      mockGetPlugin.mockReturnValue({ skillContent: 'Always write in present tense.' });
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'wuxia',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## Skill Instructions');
      expect(prompt).toContain('Always write in present tense.');
    });

    it('omits skill section when no skillId given', async () => {
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## Skill Instructions');
    });

    it('omits skill section when plugin not found', async () => {
      mockGetPlugin.mockReturnValue(null);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'missing',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## Skill Instructions');
    });
  });

  describe('conversation history', () => {
    it('injects user/assistant turns with labels', async () => {
      const prompt = await composePrompt({
        message: 'continue',
        projectId: 'p',
        projectDir: tempDir,
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
        ],
      });
      expect(prompt).toContain('## Conversation History');
      expect(prompt).toContain('### User');
      expect(prompt).toContain('first question');
      expect(prompt).toContain('### Assistant');
      expect(prompt).toContain('first answer');
    });

    it('omits history section when empty', async () => {
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        projectDir: tempDir,
        history: [],
      });
      expect(prompt).not.toContain('## Conversation History');
    });
  });

  it('ends with the user request', async () => {
    const prompt = await composePrompt({
      message: 'write chapter 2',
      projectId: 'p',
      projectDir: tempDir,
    });
    expect(prompt).toContain('## User Request\nwrite chapter 2');
  });

  it('orders sections consistently', async () => {
    await seedProjectFiles(tempDir);
    mockGetPlugin.mockReturnValue({ skillContent: 'SKILL_BODY' });
    const prompt = await composePrompt({
      message: 'go',
      projectId: 'p',
      skillId: 'wuxia',
      projectDir: tempDir,
      history: [{ role: 'user', content: 'prev' }],
    });
    const idx = (s: string) => prompt.indexOf(s);
    expect(idx('## 文件访问规则')).toBeLessThan(idx('## Project Context'));
    expect(idx('## Project Context')).toBeLessThan(idx('## Current Stage:'));
    expect(idx('## Current Stage:')).toBeLessThan(idx('## Project Files'));
    expect(idx('## Project Files')).toBeLessThan(idx('## Available Tools'));
    expect(idx('## Available Tools')).toBeLessThan(idx('## Output Format'));
    expect(idx('## Output Format')).toBeLessThan(idx('## Skill Instructions'));
    expect(idx('## Skill Instructions')).toBeLessThan(idx('## Conversation History'));
    expect(idx('## Conversation History')).toBeLessThan(idx('## User Request'));
  });

  describe('writing-stage context layers', () => {
    async function seedWritingProject(d: string) {
      const novel = path.join(d, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(path.join(novel, 'concept.md'), '# 故事概念\n核心冲突');
      await fs.writeFile(path.join(novel, 'world-building.md'), '# 世界观\n魔法体系');
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({
          characters: [
            { name: '林青', location: '客栈', emotion: '警觉', knows: ['密道'], relationships: { 苏晚: '盟友' }, lastAppearance: 1 },
          ],
          timeline: '第一夜',
          activeForeshadows: [1],
          lastUpdatedChapter: 1,
          updatedAt: '2026-01-01',
        }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            // #1 已埋待回收（planted）——应进入「待回收」区
            { id: 1, content: '神秘信件', status: 'planted', plantedIn: 1 },
            // #2 已回收——不应出现在活跃伏笔层
            { id: 2, content: '已回收的伏笔', status: 'resolved', plantedIn: 1, resolvedIn: 2 },
            // #3 本章（第2章）须埋——应进入置顶提醒
            { id: 3, content: '黑玉印章', status: 'pending', plantedIn: 2 },
          ],
        }),
      );
      await fs.writeFile(path.join(novel, 'chapters', '第1章.summary.md'), '林青抵达客栈后，从掌柜手中接过一封无名密信，信上只有朱砂画的半截剑刃。他立刻警觉起来，回房后取出暗藏的短刀，等待天明。');
    }

    it('injects all context layers in writing stage', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## Novel Context Layers');
      expect(prompt).toContain('### 核心设定层（恒定）');
      expect(prompt).toContain('核心冲突');
      expect(prompt).toContain('魔法体系');
      expect(prompt).toContain('### 状态层');
      expect(prompt).toContain('林青');
      expect(prompt).toContain('### 滚动摘要层');
      expect(prompt).toContain('林青抵达客栈');
      expect(prompt).toContain('### 活跃伏笔层');
      expect(prompt).toContain('待回收');
      expect(prompt).toContain('神秘信件');
      // 已回收伏笔不应出现
      expect(prompt).not.toContain('已回收的伏笔');
      // 第2章须埋设的伏笔应置顶提醒（lastUpdatedChapter=1 → currentChapter=2）
      expect(prompt).toContain('本章须埋设的伏笔');
      expect(prompt).toContain('黑玉印章');
    });

    it('does not inject layers in concept stage (unchanged behavior)', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## Novel Context Layers');
      // 仍保留文件名列表行为
      expect(prompt).toContain('## Project Files');
    });

    it('keeps layered context between Project Files and Available Tools', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      const idx = (s: string) => prompt.indexOf(s);
      expect(idx('## Project Files')).toBeLessThan(idx('## Novel Context Layers'));
      expect(idx('## Novel Context Layers')).toBeLessThan(idx('## Available Tools'));
    });

    it('buildForeshadowLayer: planted 进待回收区，pending 本章须埋置顶，逾期未埋单独警示', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 5, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            { id: 1, content: '已埋待回收', status: 'planted', plantedIn: 3 },
            { id: 2, content: '逾期未埋', status: 'pending', plantedIn: 2 },
            { id: 3, content: '本章须埋', status: 'pending', plantedIn: 6 },
            { id: 4, content: '未来伏笔不显示', status: 'pending', plantedIn: 10 },
            { id: 5, content: '已回收', status: 'resolved', plantedIn: 1, resolvedIn: 4 },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第六章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      // 本章须埋置顶
      expect(prompt).toContain('本章须埋设的伏笔');
      expect(prompt).toContain('本章须埋');
      // planted 进待回收
      expect(prompt).toContain('待回收');
      expect(prompt).toContain('已埋待回收');
      // 逾期未埋警示
      expect(prompt).toContain('逾期未埋');
      expect(prompt).toContain('逾期未埋');
      // 未来伏笔不显示
      expect(prompt).not.toContain('未来伏笔不显示');
      // 已回收不显示
      expect(prompt).not.toContain('已回收');
    });

    it('buildForeshadowLayer: 无 planted 且无逾期时活跃伏笔层不出现', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 5, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            { id: 1, content: '未来伏笔', status: 'pending', plantedIn: 10 },
            { id: 2, content: '已回收', status: 'resolved', plantedIn: 1, resolvedIn: 3 },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第六章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      // 无 planted、无逾期 → 活跃伏笔层不出现
      expect(prompt).not.toContain('### 活跃伏笔层');
      // 未来伏笔也不进入置顶提醒（plantedIn=10 ≠ currentChapter=6）
      expect(prompt).not.toContain('本章须埋设的伏笔');
    });
  });

  describe('阶段不匹配检测 (Bug #4)', () => {
    it('scenes 阶段发送写作意图时提示词包含阶段不匹配警告', async () => {
      const prompt = await composePrompt({
        message: '请写第3章',
        projectId: 'p',
        stage: 'scenes',
        projectDir: tempDir,
      });
      expect(prompt).toContain('阶段不匹配提醒');
      expect(prompt).toContain('scenes');
      expect(prompt).toContain('PATCH /api/projects');
    });

    it('writing 阶段发送写作意图时不触发警告', async () => {
      const prompt = await composePrompt({
        message: '请写第3章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('阶段不匹配提醒');
    });

    it('concept 阶段发送非写作指令时不触发警告', async () => {
      const prompt = await composePrompt({
        message: '帮我完善主角的背景故事',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('阶段不匹配提醒');
    });

    it('“继续写”也触发写作意图检测', async () => {
      const prompt = await composePrompt({
        message: '继续写下一章',
        projectId: 'p',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).toContain('阶段不匹配提醒');
    });
  });
});
