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
const { composePrompt, parseChapterNumberFromMessage, findNextUnwrittenChapter, buildContextSectionReport } = await import('../../../src/agent/prompt-composer');

// 用于识别各阶段指令的特征文本（STAGE_INSTRUCTIONS 的首句片段）。
const STAGE_FEATURES: Record<string, string> = {
  concept: '聚焦于构思核心概念',
  world: '构建故事世界',
  characters: '撰写详细的角色档案',
  outline: '创建详细的故事大纲',
  scenes: '将大纲拆解为详细场景',
  sample: '写 3 章样章检验声口与节奏',
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
          expect(prompt).toContain('提问工具');
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

      it('outline 落盘指令含承诺等级语法说明与粒度梯度要求', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'outline',
          projectDir: tempDir,
        });
        // 卡片引用行语法
        expect(prompt).toContain('> commitment: committed');
        expect(prompt).toContain('> open-questions:');
        // 三级语义
        expect(prompt).toContain('committed（已定）');
        expect(prompt).toContain('tentative（倾向）');
        expect(prompt).toContain('open（待决策）');
        // 近细远粗梯度 + 远粗是设计
        expect(prompt).toContain('粒度梯度要求（近细远粗）');
        expect(prompt).toContain('远期章节粗粒度是设计而非未完成');
        // outline-meta.json 同步 commitment
        expect(prompt).toContain('"commitment": "committed"');
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

      // 守卫：agent 不得用文字表格/列表代替提问工具呈现选项
      it('规划阶段注入「禁止用纯文字列举选项」铁律', async () => {
        const prompt = await composePrompt({
          message: '帮我完善概念',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
        });
        expect(prompt).toContain('铁律');
        expect(prompt).toContain('禁止用纯文字列举');
        // 多决策场景指导
        expect(prompt).toContain('逐个发起提问');
      });

      it('TOOL_INSTRUCTIONS 含禁止文字代替提问工具的规则', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
        });
        expect(prompt).toContain('NEVER present A/B/C options');
      });

      it('非自治模式 questionRule 含禁止文字代替条款', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
        });
        expect(prompt).toContain('禁止用文字代替提问工具');
      });

      // 守卫：prompt 中不应硬编码单一工具名，应使用环境无关的「提问工具」
      it('行为指令使用「提问工具」而非硬编码 question', async () => {
        const prompt = await composePrompt({
          message: '帮我完善概念',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
        });
        // TOOL_INSTRUCTIONS 应列出内置 Pi 的 ask 工具
        expect(prompt).toContain('**ask** — Ask the user to choose between options');
        // 行为指令应使用「提问工具」
        expect(prompt).toContain('用提问工具就');
      });

      it('注入 canon 台账与章节合同', async () => {
        await fs.mkdir(path.join(tempDir, '.novel', 'contracts'), { recursive: true });
        await fs.mkdir(path.join(tempDir, '.novel', 'canon'), { recursive: true });
        await fs.writeFile(
          path.join(tempDir, '.novel', 'contracts', '第1章.json'),
          JSON.stringify({
            chapter: 1,
            pov: '林岚',
            cast: ['林岚'],
            beats: ['发现密信'],
            mustReveal: ['密信'],
            mustNotReveal: ['真凶身份'],
            wordBudget: { target: 1000 },
            status: 'frozen',
          }),
          'utf-8',
        );
        await fs.writeFile(
          path.join(tempDir, '.novel', 'canon', 'canon.json'),
          JSON.stringify({
            version: 1,
            entities: [{ id: 'e1', name: '林岚', type: 'character', aliases: ['阿岚'], status: 'active' }],
            facts: [{ id: 'f1', subject: '林岚', predicate: 'location', object: '山门', validFrom: 1, status: 'active', confidence: 'confirmed' }],
            knowledge: { 林岚: { knows: ['师父遇害'], doesNotKnow: [] } },
          }),
          'utf-8',
        );

        const prompt = await composePrompt({
          message: '写第1章',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          agentId: 'pi',
        });
        expect(prompt).toContain('章节合同（第1章，已冻结');
        expect(prompt).toContain('禁止提前揭示：真凶身份');
        expect(prompt).toContain('Canon 台账');
        expect(prompt).toContain('location = 山门');
        expect(prompt).toContain('已知：师父遇害');
      });

      it('writing 阶段指令采用职责分离（正文与状态更新分离）', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
        });
        // 职责分离：写正文后由当前 Pi 会话以 state-patcher 视角回写状态
        expect(prompt).toContain('写章流程（职责分离）');
        expect(prompt).toContain('以 state-patcher 视角完成状态更新');
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
          expect(prompt).not.toContain('本阶段需要用 提问工具与用户确认的关键创作决策');
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
        expect(prompt).toContain('禁用提问工具');
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

    describe('内置 Pi 的职责分离指导', () => {
      it('writing 阶段注入内置 Pi 的自检/状态回写指导', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          agentId: 'pi',
        });
        expect(prompt).toContain('## 职责分离（内置 Pi）');
        expect(prompt).toContain('不要声称已经调用子代理');
        expect(prompt).toContain('.novel/chapters/第N章.summary.md');
        expect(prompt).toContain('.novel/character-states.md');
        expect(prompt).toContain('.novel/progress.md');
        expect(prompt).toContain('.novel/state.json');
        expect(prompt).toContain('.novel/foreshadow.json');
      });

      it('未指定 agentId 时不注入职责分离指导', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
        });
        expect(prompt).not.toContain('## 职责分离（内置 Pi）');
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

    it('does not inject writing-stage Novel Context Layers in concept stage', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      // 写作阶段的分层上下文不注入（状态/摘要/伏笔等）
      expect(prompt).not.toContain('## Novel Context Layers');
      // 但规划阶段核心设定已注入（见 planning-stage context layer 测试）
      expect(prompt).toContain('## 项目核心设定');
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

    it('POV 知情边界：有数据才注入，无数据/空表时提示词不含该层', async () => {
      await seedWritingProject(tempDir);
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：夜行\n- **POV**：林青\n- **核心事件**：夜行',
      );
      // 去掉 state.json 的已知信息，确保无任何知情数据
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({
          characters: [{ name: '林青', location: '客栈', emotion: '警觉', knows: [], relationships: {}, lastAppearance: 1 }],
          timeline: '第一夜',
          activeForeshadows: [],
          lastUpdatedChapter: 1,
          updatedAt: '2026-01-01',
        }),
      );

      const without = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(without).not.toContain('### POV 知情边界');

      // 空表同样不注入
      await fs.writeFile(path.join(novel, 'character-knowledge.json'), '{"characters":[]}');
      const empty = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(empty).not.toContain('### POV 知情边界');

      // 有数据时注入，且位于角色层之后、滚动摘要层之前
      await fs.writeFile(
        path.join(novel, 'character-knowledge.json'),
        JSON.stringify({
          characters: [{
            name: '林青',
            knows: [{ fact: '密道在厨房后面', learnedIn: 2 }],
            doesNotKnow: ['自己的真实身世'],
            updatedChapter: 2,
          }],
        }),
      );
      const withData = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(withData).toContain('### POV 知情边界（林青）');
      expect(withData).toContain('密道在厨房后面');
      expect(withData).toContain('第2章获知');
      expect(withData).toContain('尚不知（禁止以此行动）');
      expect(withData).toContain('自己的真实身世');
      const idx = (s: string) => withData.indexOf(s);
      expect(idx('### 本章出场角色层')).toBeLessThan(idx('### POV 知情边界（林青）'));
      expect(idx('### POV 知情边界（林青）')).toBeLessThan(idx('### 滚动摘要层'));
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

    it('buildContextSectionReport：未超预算时逐字保留全部层文本（组装行为与改前一致）', async () => {
      await seedWritingProject(tempDir);
      const report = await buildContextSectionReport(tempDir, 2, 'p');

      expect(report.prompt.startsWith('## Novel Context Layers\n\n')).toBe(true);
      // 未发生任何裁剪
      expect(report.prompt).not.toContain('…（已截断）');
      expect(report.sections.every((s) => s.kept)).toBe(true);
      expect(report.sections.some((s) => s.truncatedTo !== undefined)).toBe(false);
      expect(report.totalTokens).toBeLessThanOrEqual(report.budgetTokens);
      // DB mock 查不到 pi_context_window → 默认 128k；128k×0.4=51.2k 触及 48k 上限
      expect(report.budgetTokens).toBe(48_000);

      // 各层文本逐字进入 prompt（与层构建函数输出一致，未被预算改写）
      expect(report.prompt).toContain('### 核心设定层（恒定）');
      expect(report.prompt).toContain('### 状态层\n- 时间线：第一夜\n- **林青**；位置=客栈；情绪=警觉；已知=[密道]；关系=[苏晚:盟友]；最后出场=第1章');
      expect(report.prompt).toContain('### 精排窗口\n精排窗口：第 2..11 章应达 beat 级（场景/冲突/结果齐备）；其中仍为 tentative/open 的章节，先精化对应大纲卡片再写。远期章节保持 arc/骨架级是设计意图，无需提前补全。');
      expect(report.prompt).toContain('### 滚动摘要层（最近 3 章详摘，更早章节简摘）');
      expect(report.prompt).toContain('林青抵达客栈');
      expect(report.prompt).toContain('### 活跃伏笔层');

      // 报告含层名/优先级/token
      const stateEntry = report.sections.find((s) => s.name === '状态表')!;
      expect(stateEntry.priority).toBe(3);
      expect(stateEntry.tokens).toBeGreaterThan(0);
      expect(report.sections.find((s) => s.name === '滚动摘要')!.priority).toBe(4);
      expect(report.sections.find((s) => s.name === '活跃伏笔')!.priority).toBe(5);
    });

    it('buildContextSectionReport：滚动摘要层超预算时被整层丢弃并注明', async () => {
      await seedWritingProject(tempDir);
      // 6 万字摘要 → 滚动摘要层 token 远超 48k 预算
      await fs.writeFile(
        path.join(tempDir, '.novel', 'chapters', '第1章.summary.md'),
        '概'.repeat(60_000),
      );
      const report = await buildContextSectionReport(tempDir, 2, 'p');

      const rolling = report.sections.find((s) => s.name === '滚动摘要')!;
      expect(rolling.kept).toBe(false);
      expect(rolling.tokens).toBeGreaterThan(48_000);
      // 高优先层（状态 priority 3 < 滚动摘要被丢后仍保留）不受影响
      expect(report.sections.find((s) => s.name === '状态表')!.kept).toBe(true);
      expect(report.prompt).toContain('### 状态层');
      expect(report.prompt).not.toContain('概概');
      expect(report.totalTokens).toBeLessThanOrEqual(report.budgetTokens);
      // 裁剪发生时 prompt 末尾注明被裁层
      expect(report.prompt).toContain('以上上下文超出 token 预算');
      expect(report.prompt).toMatch(/整层省略：.*滚动摘要/);
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
      await fs.mkdir(path.join(tempDir, '.novel', 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.novel', 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：下山\n- **核心事件**：下山遇强敌',
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

    it('本章大纲按承诺等级注入框架语：committed=写作依据必须遵循', async () => {
      await seedWritingProject(tempDir);
      await fs.mkdir(path.join(tempDir, '.novel', 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.novel', 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：夜巡\n> commitment: committed\n- **主要场景**：夜巡遇袭',
      );
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('committed（已定）');
      expect(prompt).toContain('写作依据');
      expect(prompt).toContain('不得偏离');
      expect(prompt).not.toContain('tentative（倾向）');
    });

    it('tentative 大纲注入可推翻但须回写的要求（缺省即 tentative）', async () => {
      await seedWritingProject(tempDir);
      await fs.mkdir(path.join(tempDir, '.novel', 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.novel', 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：变阵\n> commitment: tentative\n- **走向（arc）**：被迫变阵',
      );
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('tentative（倾向）');
      expect(prompt).toContain('可被正文推翻');
      expect(prompt).toContain('回写 outline/chapters/第2章.md');
    });

    it('open 大纲附带待决策问题并要求写完回填', async () => {
      await seedWritingProject(tempDir);
      await fs.mkdir(path.join(tempDir, '.novel', 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.novel', 'outline', 'chapters', '第2章.md'),
        [
          '## 第 2 章：分岔',
          '> commitment: open',
          '> open-questions:',
          '>   - 敌人身份是否当场揭穿',
          '',
          '- **幕级骨架**：主角在渡口遭遇伏兵。',
        ].join('\n'),
      );
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('open（待决策）');
      expect(prompt).toContain('> - 敌人身份是否当场揭穿');
      expect(prompt).toContain('回填 outline/chapters/第2章.md');
      expect(prompt).toContain('决策结果');
    });

    it('注入精排窗口行：lastUpdatedChapter=1 → 第 2..11 章应达 beat 级', async () => {
      await seedWritingProject(tempDir);
      const prompt = await composePrompt({
        message: '写第二章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('精排窗口');
      expect(prompt).toContain('第 2..11 章应达 beat 级');
      expect(prompt).toContain('先精化');
      expect(prompt).toContain('远期章节保持 arc/骨架级是设计意图');
    });

    it('injects cast layer with POV profile in writing stage', async () => {
      const novel = path.join(tempDir, '.novel');
      await seedWritingProject(tempDir);
      await fs.mkdir(path.join(novel, 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：下山\n- **POV**：林青\n- **出场角色**：林青',
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
      await fs.mkdir(path.join(novel, 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(path.join(novel, 'outline', 'chapters', '第2章.md'), '## 第 2 章\n- **POV**：林青');
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

    it('loadForeshadows 迁移旧格式 plantedIn 自由文本（"第64-66章"→64）', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 70, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            // 旧格式：plantedIn 是自由文本——迁移后应提取首个数字 64
            { id: 1, content: '旧格式伏笔', status: 'planted', plantedIn: '第64-66章', resolvedIn: null },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第七十一章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('旧格式伏笔');
      expect(prompt).toContain('埋于第64章');
    });

    it('注入层标注 [类型][权重]、期限逾期与前置依赖，并含密度预算行', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 10, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            // #1 期限 8 < 当前章 11 → 逾期标记；依赖 #2；重磅身份伏笔
            { id: 1, content: '身份伏笔', type: 'identity', status: 'planted', plantedIn: 3, resolveDeadline: 8, resolvedIn: null, dependsOn: [2], weight: 'major' },
            // #2 期限 15 > 11 → 不逾期；轻量情感伏笔
            { id: 2, content: '情感伏笔', type: 'emotional', status: 'planted', plantedIn: 2, resolveDeadline: 15, resolvedIn: null, dependsOn: [], weight: 'light' },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第十一章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('[身份之谜][重磅]');
      expect(prompt).toContain('期限：第8章前回收 ⚠已逾期');
      expect(prompt).toContain('前置：#2');
      expect(prompt).toContain('[情感线][轻量]');
      expect(prompt).toContain('期限：第15章前回收');
      // 逾期/临期提醒块（有界注入）
      expect(prompt).toContain('### ⏰ 伏笔到期提醒');
      expect(prompt).toContain('已逾期 1 条');
      expect(prompt).toContain('即将到期 1 条');
      expect(prompt).toContain('期限在第12~21章');
      // 密度预算行（每 3 章新埋不超过 2 条）
      expect(prompt).toContain('密度预算');
      expect(prompt).toContain('可新埋');
    });

    it('推进中伏笔进入活跃伏笔层并标注 progressedIn 章号', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 10, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            { id: 1, content: '推进中的身份线', type: 'identity', status: 'progressing', plantedIn: 2, resolveDeadline: 14, resolvedIn: null, progressedIn: [5, 8], dependsOn: [], weight: 'major' },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第十一章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('### 活跃伏笔层');
      expect(prompt).toContain('**推进中**');
      expect(prompt).toContain('推进于第5章、第8章');
      expect(prompt).toContain('### ⏰ 伏笔到期提醒');
      expect(prompt).toContain('即将到期 1 条');
    });

    it('到期提醒有界：超过 5 条时折叠剩余条目', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 10, updatedAt: '' }),
      );
      const foreshadows = Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        content: `逾期伏笔${i + 1}`,
        type: 'chekhov',
        status: 'planted',
        plantedIn: 1,
        resolveDeadline: 5,
        resolvedIn: null,
        progressedIn: [],
        dependsOn: [],
        weight: 'light',
      }));
      await fs.writeFile(path.join(novel, 'foreshadow.json'), JSON.stringify({ foreshadows }));
      const prompt = await composePrompt({
        message: '写第十一章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('已逾期 7 条');
      const reminder = prompt.slice(prompt.indexOf('### ⏰ 伏笔到期提醒'));
      expect(reminder).toContain('另有 2 条逾期');
      // 提醒块内有界：只列前 5 条，其余折叠
      expect(reminder).toContain('逾期伏笔5');
      expect(reminder).not.toContain('逾期伏笔6');
      expect(reminder).not.toContain('逾期伏笔7');
    });

    it('孤儿章号高亮警告：plantedIn 超出全书章数', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
      await fs.writeFile(path.join(novel, 'chapters', '第1章.md'), '第一章正文');
      await fs.writeFile(path.join(novel, 'chapters', '第2章.md'), '第二章正文');
      await fs.writeFile(
        path.join(novel, 'state.json'),
        JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 2, updatedAt: '' }),
      );
      await fs.writeFile(
        path.join(novel, 'foreshadow.json'),
        JSON.stringify({
          foreshadows: [
            // 全书只有 2 章，plannedIn=99 超范围——孤儿章号警告
            { id: 9, content: '超范围伏笔', type: 'world', status: 'pending', plantedIn: 99, resolveDeadline: null, resolvedIn: null, dependsOn: [], weight: 'light' },
          ],
        }),
      );
      const prompt = await composePrompt({
        message: '写第三章',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).toContain('### 活跃伏笔层');
      expect(prompt).toContain('孤儿章号警告');
      expect(prompt).toContain('plantedIn=99');
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
      await fs.mkdir(path.join(novel, 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：群战\n- **POV**：甲\n- **出场角色**：甲、乙、丙、丁、戊',
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
      await fs.mkdir(path.join(novel, 'outline', 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'outline', 'chapters', '第2章.md'),
        '## 第 2 章：下山\n- **POV**：林青\n- **出场角色**：林青',
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

  describe('planning-stage context layer (预注入核心设定)', () => {
    /** 创建含 concept/world 详情文件的测试项目 */
    async function seedPlanningProject(d: string) {
      const novel = path.join(d, '.novel');
      await fs.mkdir(path.join(novel, 'concept'), { recursive: true });
      await fs.writeFile(path.join(novel, 'concept', 'index.md'), '# 概念索引');
      await fs.writeFile(path.join(novel, 'concept', '核心主题.md'), '# 核心主题\n侠义与灭门');
      await fs.writeFile(path.join(novel, 'concept', '一句话梗概.md'), '少年复仇的故事');
      await fs.mkdir(path.join(novel, 'world'), { recursive: true });
      await fs.writeFile(path.join(novel, 'world', 'index.md'), '# 世界观索引');
      await fs.writeFile(path.join(novel, 'world', '世界规则.md'), '剑气可以凝结');
      await fs.writeFile(path.join(novel, 'outline-brief.md'), '# 大纲简述\n第一幕：灭门');
    }

    it('concept 阶段注入 concept/world 全部文件 + outline-brief', async () => {
      await seedPlanningProject(tempDir);
      const prompt = await composePrompt({
        message: '帮我完善概念',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## 项目核心设定（已注入——无需再 Read）');
      // concept 文件全部注入
      expect(prompt).toContain('### concept/核心主题.md');
      expect(prompt).toContain('侠义与灭门');
      expect(prompt).toContain('### concept/一句话梗概.md');
      expect(prompt).toContain('少年复仇的故事');
      // world 文件注入
      expect(prompt).toContain('### world/世界规则.md');
      expect(prompt).toContain('剑气可以凝结');
      // outline-brief 注入
      expect(prompt).toContain('### outline-brief.md');
      expect(prompt).toContain('第一幕：灭门');
    });

    it('所有规划阶段均注入核心设定', async () => {
      await seedPlanningProject(tempDir);
      for (const stage of ['concept', 'world', 'characters', 'outline', 'scenes']) {
        const prompt = await composePrompt({
          message: 'go',
          projectId: 'p',
          stage,
          projectDir: tempDir,
        });
        expect(prompt).toContain('## 项目核心设定');
      }
    });

    it('写作阶段不注入 planning context layer', async () => {
      await seedPlanningProject(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## 项目核心设定');
      // 写作阶段用的是 Novel Context Layers（核心设定层是索引模式）
      expect(prompt).toContain('### 核心设定层（恒定）');
    });

    it('concept/world 文件总量超 80KB 时退化为索引模式', async () => {
      const novel = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novel, 'concept'), { recursive: true });
      // 写两个大文件，总计 >80KB
      const big = 'x'.repeat(50 * 1024);
      await fs.writeFile(path.join(novel, 'concept', '大文件1.md'), big);
      await fs.writeFile(path.join(novel, 'concept', '大文件2.md'), big);
      const prompt = await composePrompt({
        message: 'go',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      // 退化为索引模式
      expect(prompt).toContain('## 项目核心设定索引');
      expect(prompt).toContain('超过 80KB 预算');
      expect(prompt).toContain('concept/大文件1.md');
      // 不注入全文
      expect(prompt).not.toContain('## 项目核心设定（已注入');
    });

    it('deepen 模式跳过 planning context layer（由 deepen 块自行注入）', async () => {
      await seedPlanningProject(tempDir);
      const prompt = await composePrompt({
        message: '继续深化',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
        deepenContext: { round: 1 },
      });
      // deepen 模式不注入 planning context
      expect(prompt).not.toContain('## 项目核心设定（已注入');
      // deepen 注入自己的阶段产出文件
      expect(prompt).toContain('## 当前阶段产出文件');
    });

    it('concept/world 均为空时不注入 planning context', async () => {
      // tempDir 为空（无 .novel/concept 和 .novel/world）
      const prompt = await composePrompt({
        message: 'go',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## 项目核心设定');
    });

    it('planning context 位于 Project Files 与 Available Tools 之间', async () => {
      await seedPlanningProject(tempDir);
      const prompt = await composePrompt({
        message: 'go',
        projectId: 'p',
        stage: 'concept',
        projectDir: tempDir,
      });
      const idx = (s: string) => prompt.indexOf(s);
      expect(idx('## Project Files')).toBeLessThan(idx('## 项目核心设定'));
      expect(idx('## 项目核心设定')).toBeLessThan(idx('## Available Tools'));
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

  describe('intent layer injection', () => {
    it('injects intent layer when intent.md exists', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      await fs.writeFile(
        path.join(tempDir, '.novel', 'intent.md'),
        '# 作者意图卡\n\n## 节奏偏好\n\n每章 4000 字\n',
      );
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## 作者意图（以此为准）');
      expect(prompt).toContain('每章 4000 字');
      // 意图层在阶段指令之前
      expect(prompt.indexOf('## 作者意图（以此为准）')).toBeLessThan(prompt.indexOf('## Current Stage'));
    });

    it('skips intent layer when intent.md missing', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## 作者意图（以此为准）');
    });

    it('skips intent layer when intent.md is empty', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      await fs.writeFile(path.join(tempDir, '.novel', 'intent.md'), '\n');
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## 作者意图（以此为准）');
    });
  });

  describe('intent collection instruction', () => {
    it('injects intent collection instruction in outline stage (non-autonomous)', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).toContain('作者意图采集（仅大纲阶段）');
      expect(prompt).toContain('.novel/intent.md');
    });

    it('does not inject in autonomous mode', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
        autonomous: true,
      });
      expect(prompt).not.toContain('作者意图采集（仅大纲阶段）');
    });

    it('does not inject in non-outline stages', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'characters',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('作者意图采集（仅大纲阶段）');
    });
  });

  describe('sample 样章阶段', () => {
    it('注入样章协议：3 章样章 + 复盘回灌大纲', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: '开始写样章',
        projectId: 'p',
        stage: 'sample',
        projectDir: tempDir,
      });
      expect(prompt).toContain(STAGE_FEATURES.sample);
      expect(prompt).toContain('.novel/sample-feedback.md');
      expect(prompt).toContain('声口落地');
      expect(prompt).toContain('节奏体感');
      expect(prompt).toContain('世界观落地');
      expect(prompt).toContain('大纲需修正点');
    });

    it('样章章节号即真实章节号（不设平行编号）', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: '开始写样章',
        projectId: 'p',
        stage: 'sample',
        projectDir: tempDir,
      });
      expect(prompt).toContain('章节号即真实章节号');
    });

    it('落盘清单含 3 个章节文件 + sample-feedback.md + 大纲修订，并 PATCH 到 writing', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: '开始写样章',
        projectId: 'p',
        stage: 'sample',
        projectDir: tempDir,
      });
      expect(prompt).toContain('样章完成核验（落盘清单）');
      expect(prompt).toContain('3 个章节正文文件');
      expect(prompt).toContain('大纲修订');
      expect(prompt).toContain('"currentStage": "writing"');
    });

    it('样章阶段不注入采访式协议（自治写作）', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: '开始写样章',
        projectId: 'p',
        stage: 'sample',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('本阶段的协作方式：采访式');
    });

    it('样章阶段注入写作分层上下文（isWritingStage 含 sample）', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: '开始写样章',
        projectId: 'p',
        stage: 'sample',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## Novel Context Layers');
    });

    it('scenes 尾部改为推进到 sample 阶段', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        stage: 'scenes',
        projectDir: tempDir,
      });
      expect(prompt).toContain('"currentStage": "sample"');
    });

    it('样章阶段发送写作意图不触发阶段错配警告', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: '请写第1章',
        projectId: 'p',
        stage: 'sample',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('阶段不匹配提醒');
    });
  });

  describe('章号推断（parseChapterNumberFromMessage / findNextUnwrittenChapter）', () => {
    it('解析阿拉伯数字章号', () => {
      expect(parseChapterNumberFromMessage('请写第3章正文')).toBe(3);
      expect(parseChapterNumberFromMessage('写第12章')).toBe(12);
    });

    it('解析中文数字章号（含十/百）', () => {
      expect(parseChapterNumberFromMessage('写第五章')).toBe(5);
      expect(parseChapterNumberFromMessage('写第十二章')).toBe(12);
      expect(parseChapterNumberFromMessage('写第二十三章')).toBe(23);
      expect(parseChapterNumberFromMessage('写第一百零五章')).toBe(105);
    });

    it('无显式章号返回 null（写下一章/继续写）', () => {
      expect(parseChapterNumberFromMessage('写下一章')).toBeNull();
      expect(parseChapterNumberFromMessage('继续写')).toBeNull();
      expect(parseChapterNumberFromMessage('')).toBeNull();
    });

    it('扫描目录取最小未写章：样章写了 1、5、12 → 返回 2', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      for (const n of [1, 5, 12]) {
        await fs.writeFile(
          path.join(novelDir, 'chapters', `第${n}章.md`),
          `# 第${n}章\n\n${'这是正文内容。'.repeat(20)}`,
        );
      }
      expect(await findNextUnwrittenChapter(tempDir)).toBe(2);
    });

    it('连续章节全部写完 → 返回最大+1', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      for (const n of [1, 2, 3]) {
        await fs.writeFile(
          path.join(novelDir, 'chapters', `第${n}章.md`),
          `# 第${n}章\n\n${'这是正文内容。'.repeat(20)}`,
        );
      }
      expect(await findNextUnwrittenChapter(tempDir)).toBe(4);
    });

    it('空壳章节（仅标题）不算已写 → 推断回填空壳章', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      // 第1章有正文，第2章是手动创建的空壳
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        `# 第1章\n\n${'这是正文内容。'.repeat(20)}`,
      );
      await fs.writeFile(path.join(novelDir, 'chapters', '第2章.md'), '# 第2章');
      expect(await findNextUnwrittenChapter(tempDir)).toBe(2);
    });

    it('目录不存在/为空 → 返回 1；摘要与退化文件不干扰', async () => {
      expect(await findNextUnwrittenChapter(tempDir)).toBe(1);
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(path.join(novelDir, 'chapters', '第1章.summary.md'), '摘要');
      await fs.writeFile(path.join(novelDir, 'chapters', '第2章.degraded.md'), '退化');
      expect(await findNextUnwrittenChapter(tempDir)).toBe(1);
    });
  });
});
