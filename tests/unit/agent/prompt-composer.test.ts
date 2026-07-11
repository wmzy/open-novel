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
  writing: '本章大纲与出场角色档案已注入上方上下文',
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
  await fs.mkdir(path.join(dir, '.novel', 'concept'), { recursive: true });
  await fs.writeFile(path.join(dir, '.novel', 'concept', 'index.md'), '# Concept');
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

    // 守卫「采访式」协作：规划阶段注入引导流程，写作阶段保持自治。
    describe('interview-style protocol', () => {
      const PLANNING_STAGES = ['concept', 'world', 'characters', 'outline', 'scenes'];
      for (const stage of PLANNING_STAGES) {
        it(`injects interview protocol into ${stage} stage`, async () => {
          const prompt = await composePrompt({
            message: 'hi',
            projectId: 'p',
            stage,
            projectDir: tempDir,
          });
          expect(prompt).toContain('本阶段的协作方式：采访式');
          expect(prompt).toContain('question 工具');
        });
      }

      it('outline stage 指示保存到 outline/ 目录（拆分格式）', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'outline',
          projectDir: tempDir,
        });
        expect(prompt).toContain('保存到 .novel/outline/ 目录');
        expect(prompt).toContain('chapters/第N章.md');
        // 不应再指示存到旧的单文件格式
        expect(prompt).not.toContain('保存到 .novel/outline-detailed.md');
      });

      it('keeps writing stage autonomous (no interview protocol)', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
        });
        expect(prompt).not.toContain('本阶段的协作方式：采访式');
      });

      it('writing 阶段指令采用职责分离（正文与状态更新分离）', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
        });
        // 职责分离：写正文委托 state-patcher，不再内联五步指令
        expect(prompt).toContain('写章流程（职责分离）');
        expect(prompt).toContain('委托 state-patcher SubAgent 完成状态更新');
        // 五个状态文件均作为 state-patcher 的委托项列出
        expect(prompt).toContain('.novel/chapters/第N章.summary.md');
        expect(prompt).toContain('.novel/character-states.md');
        expect(prompt).toContain('.novel/progress.md');
        expect(prompt).toContain('.novel/state.json');
        expect(prompt).toContain('.novel/foreshadow.json');
        // 正文写作与状态更新不得混在一起
        expect(prompt).toContain('正文写作和状态更新不要混在一起');
        // 旧的内联五步指令已移除
        expect(prompt).not.toContain('完成以下五件事');
      });
    });

    // 写作/草稿/润色/修订阶段注入「章节正文输出协议」（借鉴 denova 输出协议约束）。
    describe('章节正文输出协议', () => {
      for (const stage of ['writing', 'drafting', 'polish']) {
        it(`${stage} 阶段提示词中包含「章节正文输出协议」`, async () => {
          const prompt = await composePrompt({
            message: 'hi',
            projectId: 'p',
            stage,
            projectDir: tempDir,
          });
          expect(prompt).toContain('章节正文输出协议');
        });
      }

      it('revision 阶段不注入章节正文输出协议（该阶段为审阅检查，不直接产出正文）', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'revision',
          projectDir: tempDir,
        });
        expect(prompt).not.toContain('章节正文输出协议');
      });
    });

    describe('autonomous mode', () => {
      const PLANNING_STAGES = ['concept', 'world', 'characters', 'outline', 'scenes'];
      for (const stage of PLANNING_STAGES) {
        it(`injects autonomous protocol (not interview) into ${stage} stage when autonomous=true`, async () => {
          const prompt = await composePrompt({
            message: 'hi',
            projectId: 'p',
            stage,
            projectDir: tempDir,
            autonomous: true,
          });
          // 自治协议存在
          expect(prompt).toContain('本阶段的协作方式：自治式');
          expect(prompt).toContain('自主决策');
          // 采访式协议不存在
          expect(prompt).not.toContain('本阶段的协作方式：采访式');
          // 决策清单不存在（autonomous 跳过）
          expect(prompt).not.toContain('本阶段需要用 question 工具与用户确认的关键创作决策');
        });
      }

      it('keeps writing stage unaffected by autonomous flag', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          autonomous: true,
        });
        expect(prompt).not.toContain('本阶段的协作方式：自治式');
        expect(prompt).not.toContain('本阶段的协作方式：采访式');
      });

      it('autonomous mode changes global priority block to forbid questions', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
          autonomous: true,
        });
        expect(prompt).toContain('采用「自治式」');
        expect(prompt).toContain('禁用 question 工具');
      });

      it('default (no autonomous) keeps interview protocol unchanged', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
        });
        expect(prompt).toContain('本阶段的协作方式：采访式');
        expect(prompt).not.toContain('本阶段的协作方式：自治式');
      });
    });

    describe('plan mode', () => {
      it('injects Plan Mode instruction when planMode=true', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
          planMode: true,
        });
        expect(prompt).toContain('## Plan Mode（规划模式）');
        expect(prompt).toContain('不要直接执行修改操作');
      });

      it('does not inject Plan Mode instruction by default', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
        });
        expect(prompt).not.toContain('## Plan Mode（规划模式）');
      });

      it('Plan Mode 是叠加层：不破坏原有阶段指令', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          planMode: true,
        });
        // 原有阶段指令仍在
        expect(prompt).toContain('## Current Stage: writing');
        // Plan Mode 叠加层存在
        expect(prompt).toContain('## Plan Mode（规划模式）');
      });
    });

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

    describe('subagent guidance injection (职责分离)', () => {
      it('agentId=omp 注入 SubAgent 使用指导，含五个状态文件', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          agentId: 'omp',
        });
        expect(prompt).toContain('## SubAgent 使用指导');
        expect(prompt).toContain('task 工具');
        expect(prompt).toContain('### state-patcher（状态更新）');
        expect(prompt).toContain('.novel/chapters/第N章.summary.md');
        expect(prompt).toContain('.novel/character-states.md');
        expect(prompt).toContain('.novel/progress.md');
        expect(prompt).toContain('.novel/state.json');
        expect(prompt).toContain('.novel/foreshadow.json');
      });

      it('agentId=opencode 注入内联状态更新指导（不支持 SubAgent）', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          agentId: 'opencode',
        });
        expect(prompt).toContain('不支持 SubAgent 委托');
        // OpenCode 自行完成五个状态文件更新
        expect(prompt).toContain('.novel/character-states.md');
        expect(prompt).toContain('.novel/progress.md');
        expect(prompt).toContain('.novel/foreshadow.json');
      });

      it('未指定 agentId 时不注入 subagent 指导', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
        });
        expect(prompt).not.toContain('## SubAgent 使用指导');
        expect(prompt).not.toContain('不支持 SubAgent 委托');
      });
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
      expect(prompt).toContain('.novel/concept/index.md');
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
      await fs.mkdir(path.join(novel, 'concept'), { recursive: true });
      await fs.writeFile(path.join(novel, 'concept', 'index.md'), '# 故事概念索引\n核心冲突');
      await fs.mkdir(path.join(novel, 'world'), { recursive: true });
      await fs.writeFile(path.join(novel, 'world', 'index.md'), '# 世界观索引\n魔法体系');
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

    it('注入进度层和角色状态层（progress.md / character-states.md 存在时）', async () => {
      await seedWritingProject(tempDir);
      const novel = path.join(tempDir, '.novel');
      await fs.writeFile(path.join(novel, 'progress.md'), '# 写作进度\n已写到第1章');
      await fs.writeFile(path.join(novel, 'character-states.md'), '# 角色当前状态\n林青在客栈，情绪警觉');
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('### 写作进度层（progress.md）');
      expect(prompt).toContain('已写到第1章');
      expect(prompt).toContain('### 角色当前状态层（character-states.md）');
      expect(prompt).toContain('林青在客栈');
    });

    it('progress.md / character-states.md 不存在时不注入对应层', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('### 写作进度层（progress.md）');
      expect(prompt).not.toContain('### 角色当前状态层（character-states.md）');
      // 其他层仍正常注入
      expect(prompt).toContain('### 状态层');
    });

    it('进度层和角色状态层位于状态层之后、滚动摘要层之前', async () => {
      await seedWritingProject(tempDir);
      const novel = path.join(tempDir, '.novel');
      await fs.writeFile(path.join(novel, 'progress.md'), '已写到第1章');
      await fs.writeFile(path.join(novel, 'character-states.md'), '角色状态');
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      const idx = (s: string) => prompt.indexOf(s);
      expect(idx('### 状态层')).toBeLessThan(idx('### 写作进度层（progress.md）'));
      expect(idx('### 写作进度层（progress.md）')).toBeLessThan(idx('### 角色当前状态层（character-states.md）'));
      expect(idx('### 角色当前状态层（character-states.md）')).toBeLessThan(idx('### 滚动摘要层'));
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

    it('injects chapter outline block in writing stage', async () => {
      await seedWritingProject(tempDir);
      await fs.writeFile(
        path.join(tempDir, '.novel', 'outline-detailed.md'),
        '#### 第2章：下山\n| POV | 林青 |\n| 核心事件 | 下山遇强敌 |',
      );
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('本章大纲（第2章）');
      expect(prompt).toContain('下山遇强敌');
    });

    it('injects cast layer with POV profile in writing stage', async () => {
      const novel = path.join(tempDir, '.novel');
      await seedWritingProject(tempDir);
      await fs.writeFile(
        path.join(novel, 'outline-detailed.md'),
        '#### 第2章：下山\n| POV | 林青 |\n| 出场角色 | 林青 |',
      );
      await fs.mkdir(path.join(novel, 'characters', 'profiles'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'characters', 'profiles', '林青.md'),
        '# 林青\n\n## 出身与经历\n复仇少年。\n\n## 驱动力三角\n核心缺陷：太窄',
      );
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('本章出场角色层');
      expect(prompt).toContain('林青');
      expect(prompt).toContain('太窄');
    });

    it('outline block precedes cast layer', async () => {
      const novel = path.join(tempDir, '.novel');
      await seedWritingProject(tempDir);
      await fs.writeFile(path.join(novel, 'outline-detailed.md'), '#### 第2章\n| POV | 林青 |');
      await fs.mkdir(path.join(novel, 'characters', 'profiles'), { recursive: true });
      await fs.writeFile(path.join(novel, 'characters', 'profiles', '林青.md'), '# 林青\n## 出身与经历\nx');
      const prompt = await composePrompt({
        message: '写第二章', projectId: 'p', stage: 'writing', projectDir: tempDir,
      });
      const outlineIdx = prompt.indexOf('本章大纲');
      const castIdx = prompt.indexOf('本章出场角色层');
      expect(outlineIdx).toBeGreaterThan(-1);
      expect(castIdx).toBeGreaterThan(outlineIdx);
    });

    it('loadForeshadows 拒绝非标准 schema（items 键 / description 字段）', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: ['foreshadow-001'], lastUpdatedChapter: 2, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          // 非标准：顶层 items + description 字段——应被拒绝，不注入任何伏笔
          items: [
            { id: 'foreshadow-001', description: '蝴蝶玉佩', status: 'planted', plantedChapter: 1 },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第三章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      // 非标准 schema 不被解析——活跃伏笔层不注入
      expect(prompt).not.toContain('### 活跃伏笔层');
      expect(prompt).not.toContain('蝴蝶玉佩');
    });

    it('核心设定层注入 concept/world 索引而非全文', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      // 索引格式注入
      expect(prompt).toContain('#### 故事概念索引 (concept/index.md)');
      expect(prompt).toContain('#### 世界观索引 (world/index.md)');
      expect(prompt).toContain('核心冲突');
      expect(prompt).toContain('魔法体系');
      // 按需读取提示存在
      expect(prompt).toContain('Read 工具读取 concept/');
      expect(prompt).toContain('Read 工具读取 world/');
    });

    it('角色档案总内容超过阈值时退化为索引模式', async () => {
      const novel = path.join(tempDir, '.novel');
      await seedWritingProject(tempDir);
      // 多个角色，每个档案较大，总长 > 6000 字符
      await fs.writeFile(
        path.join(novel, 'outline-detailed.md'),
        '#### 第2章：群战\n| POV | 甲 |\n| 出场角色 | 甲、乙、丙、丁、戊 |',
      );
      await fs.mkdir(path.join(novel, 'characters', 'profiles'), { recursive: true });
      for (const name of ['甲', '乙', '丙', '丁', '戊']) {
        await fs.writeFile(
          path.join(novel, 'characters', 'profiles', `${name}.md`),
          `# ${name}\n\n## 出身与经历\n${'详细背景。'.repeat(300)}`,
        );
      }

      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      // 退化为索引模式
      expect(prompt).toContain('### 本章出场角色索引');
      expect(prompt).toContain('本章涉及角色：');
      // 五个角色名都出现在索引中
      for (const name of ['甲', '乙', '丙', '丁', '戊']) {
        expect(prompt).toContain(name);
      }
      // 按需读取提示存在
      expect(prompt).toContain('请用 Read 工具读取');
      // 完整角色档案层标题不再出现
      expect(prompt).not.toContain('### 本章出场角色层');
    });

    it('角色档案总内容小于阈值时正常全量注入角色层', async () => {
      const novel = path.join(tempDir, '.novel');
      await seedWritingProject(tempDir);
      await fs.writeFile(
        path.join(novel, 'outline-detailed.md'),
        '#### 第2章：下山\n| POV | 林青 |\n| 出场角色 | 林青 |',
      );
      await fs.mkdir(path.join(novel, 'characters', 'profiles'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'characters', 'profiles', '林青.md'),
        '# 林青\n\n## 出身与经历\n复仇少年。\n\n## 驱动力三角\n核心缺陷：太窄',
      );

      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      // 正常全量注入
      expect(prompt).toContain('### 本章出场角色层');
      expect(prompt).toContain('太窄');
      // 不出现索引模式
      expect(prompt).not.toContain('### 本章出场角色索引');
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

  describe('revise 模式', () => {
    it('注入 REVISE_INSTRUCTIONS + 目标文件全文 + 修订意见，不注入阶段指令', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        '# 第一章\n\n这是已有的正文内容。\n',
      );

      const prompt = await composePrompt({
        message: '主角太冷，加温度',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'chapters/第1章.md',
        reviseNote: '主角太冷，加温度',
        reviseContent: '# 第一章\n\n这是已有的正文内容。\n',
      });
      expect(prompt).toContain('修订已有内容');
      expect(prompt).toContain('这是已有的正文内容');
      expect(prompt).toContain('主角太冷，加温度');
      expect(prompt).toContain('外科手术');
      // revise 模式不注入阶段指令（STAGE_INSTRUCTIONS）
      expect(prompt).not.toContain('为小说撰写真正的散文正文');
    });

    it('目标是章节时注入核心设定层（保持连续性）', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.mkdir(path.join(novelDir, 'concept'), { recursive: true });
      await fs.writeFile(path.join(novelDir, 'concept', 'index.md'), '这是一个武侠故事。');
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        '# 第一章\n\n正文。\n',
      );

      const prompt = await composePrompt({
        message: '修改',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'chapters/第1章.md',
        reviseNote: '修改',
        reviseContent: '# 第一章\n\n正文。\n',
      });
      expect(prompt).toContain('Novel Context Layers');
    });

    it('目标是设定文件时不注入章节摘要层', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'characters'), { recursive: true });
      await fs.mkdir(path.join(novelDir, 'concept'), { recursive: true });
      await fs.writeFile(path.join(novelDir, 'concept', 'index.md'), '概念。');
      await fs.writeFile(
        path.join(novelDir, 'characters', 'profiles.md'),
        '## 一、主角\n\n角色描述。\n',
      );

      const prompt = await composePrompt({
        message: '让主角更立体',
        projectId: 'p',
        stage: 'characters',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'characters/profiles.md',
        reviseNote: '让主角更立体',
        reviseContent: '## 一、主角\n\n角色描述。\n',
      });
      expect(prompt).toContain('修订已有内容');
      // 设定文件修订不注入章节上下文层
      expect(prompt).not.toContain('Novel Context Layers');
    });

    it('revise 模式不注入 Skill 指令', async () => {
      mockGetPlugin.mockReturnValue({ skillContent: '## SKILL: 撰写散文' });
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        '# 第一章\n\n正文。\n',
      );

      const prompt = await composePrompt({
        message: '修改',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
        skillId: 'novel',
        mode: 'revise',
        reviseTarget: 'chapters/第1章.md',
        reviseNote: '修改',
        reviseContent: '# 第一章\n\n正文。\n',
      });
      expect(prompt).not.toContain('SKILL: 撰写散文');
      mockGetPlugin.mockReturnValue(null);
    });

    it('revise 模式提示词中包含「输出协议」提醒', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        '# 第一章\n\n正文。\n',
      );

      const prompt = await composePrompt({
        message: '修改',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'chapters/第1章.md',
        reviseNote: '修改',
        reviseContent: '# 第一章\n\n正文。\n',
      });
      expect(prompt).toContain('### 输出协议');
      expect(prompt).toContain('修订后的文件同样必须只包含故事正文');
    });
  });

  // 异常中断恢复（借鉴 denova ResumeFromInterruption）：用户"继续"时注入中断现场。
  describe('异常中断恢复 (interruptedResume)', () => {
    it('interruptedResume 存在时，提示词中包含 [异常中断恢复] 标记和中断现场信息', async () => {
      const prompt = await composePrompt({
        message: '继续',
        projectId: 'p',
        projectDir: tempDir,
        interruptedResume: {
          userMessage: '写第三章',
          assistantContent: '第三章的内容已经写了一半…',
          reason: 'timeout',
        },
      });
      // [异常中断恢复] 标记存在
      expect(prompt).toContain('[异常中断恢复]');
      // 上一轮原始请求
      expect(prompt).toContain('上一轮原始请求：');
      expect(prompt).toContain('写第三章');
      // 上一轮中断前已生成的助手内容
      expect(prompt).toContain('上一轮中断前已生成的助手内容：');
      expect(prompt).toContain('第三章的内容已经写了一半…');
      // 本轮用户继续请求
      expect(prompt).toContain('本轮用户继续请求：');
      expect(prompt).toContain('继续');
      // 仍包含上下文边界声明
      expect(prompt).toContain('[上下文边界]');
      expect(prompt).toContain('## User Request');
    });

    it('interruptedResume 存在时，提示词中包含中断原因', async () => {
      const prompt = await composePrompt({
        message: '继续',
        projectId: 'p',
        projectDir: tempDir,
        interruptedResume: {
          userMessage: '写第三章',
          assistantContent: '',
          reason: 'watchdog 检测到死循环，进程被杀',
        },
      });
      // 中断原因
      expect(prompt).toContain('上一轮中断原因：');
      expect(prompt).toContain('watchdog 检测到死循环，进程被杀');
    });

    it('interruptedResume 不存在时，行为不变（使用普通 User Request）', async () => {
      const prompt = await composePrompt({
        message: '写第三章',
        projectId: 'p',
        projectDir: tempDir,
      });
      // 不包含中断恢复标记
      expect(prompt).not.toContain('[异常中断恢复]');
      // 普通上下文边界 + User Request
      expect(prompt).toContain('[上下文边界]');
      expect(prompt).toContain('## User Request\n写第三章');
      // 包含历史对话相关的边界声明（普通模式独有）
      expect(prompt).toContain('历史对话只能辅助理解上下文');
    });
  });

  // 创作者约束层（CREATOR.md）：最高优先级，注入于角色定义之前。
  describe('创作者指令层 (CREATOR.md)', () => {
    it('存在 .novel/CREATOR.md 时注入创作者指令块（最高优先级）', async () => {
      await fs.mkdir(path.join(tempDir, '.novel'), { recursive: true });
      const creatorContent = '# 创作者指令\n\n禁止破折号，第三人称。';
      await fs.writeFile(path.join(tempDir, '.novel', 'CREATOR.md'), creatorContent);

      const prompt = await composePrompt({
        message: '写作',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });

      // 创作者指令块存在且标注最高优先级
      expect(prompt).toContain('# 创作者指令（最高优先级——覆盖以下所有指令）');
      // 模板正文被注入
      expect(prompt).toContain('禁止破折号，第三人称。');
      // 位置：创作者指令块位于角色定义之前
      const creatorIdx = prompt.indexOf('# 创作者指令（最高优先级');
      const roleIdx = prompt.indexOf('你是一位小说创作助手');
      expect(creatorIdx).toBeGreaterThan(-1);
      expect(roleIdx).toBeGreaterThan(creatorIdx);
    });

    it('不存在 .novel/CREATOR.md 时不注入创作者指令块', async () => {
      const prompt = await composePrompt({
        message: '写作',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });

      expect(prompt).not.toContain('# 创作者指令（最高优先级');
    });
  });
});
