// @vitest-environment node
/** POST /api/projects/:projectId/inline —— 编辑器内联 AI（润色/扩写/续写）端点。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import inlineRouter from '../../../src/api/routes/inline';
import { createRun, finishRun } from '../../../src/agent/run';
import { config } from '../../../src/config';

// 只替换 callPiOnce（内联 AI 的 LLM 通道），保留模块其余导出。
vi.mock('../../../src/agent/pi/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/pi/runtime')>();
  return { ...actual, callPiOnce: vi.fn(async () => '') };
});
// vi.mock 会被提升到 import 之前，此处拿到的是 mock 后的 callPiOnce
const { callPiOnce } = await import('../../../src/agent/pi/runtime');

// 与 api-app.ts 相同的挂载方式（:projectId 参数名一致）
const app = new Hono();
app.route('/api/projects/:projectId/inline', inlineRouter);

const PROJECT_ID = 'inline_edit_project';
let projectDir: string;

const CHAPTER_BODY = '# 第1章 起风\n\n前文第一段。\n\n被选中的片段。\n\n后文第一段。\n';
const SEL_START = CHAPTER_BODY.indexOf('被选中的片段。');

function post(body: unknown) {
  return app.request(`/api/projects/${PROJECT_ID}/inline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await ensureDbReady();
  vi.mocked(callPiOnce).mockReset().mockImplementation(async () => '润色后的片段。');
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-edit-api-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: '内联编辑测试',
    path: projectDir,
    genre: 'wuxia',
    currentStage: 'writing',
  });
  await fs.mkdir(path.join(projectDir, '.novel', 'chapters'), { recursive: true });
  await fs.writeFile(path.join(projectDir, '.novel', 'chapters', '第1章.md'), CHAPTER_BODY, 'utf-8');
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('POST /api/projects/:projectId/inline', () => {
  it('润色：读取章正文、构建 prompt（前后文 + 选区）、返回 result 与段落替换计划', async () => {
    const res = await post({ chapter: 1, action: 'polish', selection: '被选中的片段。', selectionStart: SEL_START });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: string; plan: { whole: unknown; replaced: unknown[]; appended: unknown[] } };
    expect(body.result).toBe('润色后的片段。');
    expect(body.plan.whole).toBeNull();
    expect(body.plan.replaced).toEqual([{ index: 0, from: '被选中的片段。', to: '润色后的片段。' }]);
    expect(body.plan.appended).toEqual([]);

    const [prompt, cwd, timeoutMs, options] = vi.mocked(callPiOnce).mock.calls[0];
    expect(prompt).toContain('第1章');
    expect(prompt).toContain('被选中的片段。');
    expect(prompt).toContain('前文第一段。');
    expect(prompt).toContain('后文第一段。');
    expect(cwd).toBe(projectDir);
    expect(timeoutMs).toBe(Math.min(config.agent.timeoutMs, 5 * 60 * 1000));
    expect((options as { model?: string | null } | undefined)?.model).toBeNull();
  });

  it('body.model 有则透传给 callPiOnce', async () => {
    await post({ chapter: 1, action: 'expand', selection: '被选中的片段。', model: 'glm-4.7' });
    const [, , , options] = vi.mocked(callPiOnce).mock.calls[0];
    expect((options as { model?: string | null } | undefined)?.model).toBe('glm-4.7');
  });

  it('续写：无选区、光标在文末 → appended-only 计划，prompt 用光标前文', async () => {
    vi.mocked(callPiOnce).mockImplementation(async () => '续写第一段。\n\n续写第二段。');
    const res = await post({ chapter: 1, action: 'continue', selectionStart: CHAPTER_BODY.length });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: string; plan: { whole: unknown; replaced: unknown[]; appended: unknown[] } };
    expect(body.plan.whole).toBeNull();
    expect(body.plan.replaced).toEqual([]);
    expect(body.plan.appended).toEqual(['续写第一段。', '续写第二段。']);

    const [prompt] = vi.mocked(callPiOnce).mock.calls[0];
    expect(prompt).toContain('【光标前文】');
    expect(prompt).toContain('后文第一段。'); // 光标在文末，前文含最后一段
    expect(prompt).not.toContain('待续写文本');
  });

  it('selectionStart 与选区不吻合时回退按内容定位', async () => {
    await post({ chapter: 1, action: 'polish', selection: '被选中的片段。', selectionStart: 0 });
    const [prompt] = vi.mocked(callPiOnce).mock.calls[0];
    // 回退定位成功：前文取到选区之前的正文
    expect(prompt).toContain('前文第一段。');
    expect(prompt).toContain('后文第一段。');
  });

  it('定位失败（选区不在正文中）→ 前文回退 tailContext', async () => {
    await post({ chapter: 1, action: 'continue', tailContext: '兜底前文。' });
    const [prompt] = vi.mocked(callPiOnce).mock.calls[0];
    expect(prompt).toContain('兜底前文。');
  });

  it('章节正文不存在 → 404 且不调用模型', async () => {
    const res = await post({ chapter: 9, action: 'polish', selection: '片段。' });
    expect(res.status).toBe(404);
    expect(callPiOnce).not.toHaveBeenCalled();
  });

  it('项目不存在 → 404', async () => {
    const res = await app.request('/api/projects/no_such_project/inline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: 1, action: 'polish', selection: '片段。' }),
    });
    expect(res.status).toBe(404);
  });

  it('参数非法 → 400（chapter 缺失 / action 非法 / polish 无选区）', async () => {
    expect((await post({ action: 'polish', selection: '片段。' })).status).toBe(400);
    expect((await post({ chapter: 1, action: 'summarize', selection: '片段。' })).status).toBe(400);
    expect((await post({ chapter: 1, action: 'polish' })).status).toBe(400);
    expect((await post({ chapter: 0, action: 'polish', selection: '片段。' })).status).toBe(400);
    expect(callPiOnce).not.toHaveBeenCalled();
  });

  it('run 进行中 → 409 run-in-progress（处理器正确 return 锁响应，而非 404）', async () => {
    const run = createRun({
      projectId: PROJECT_ID,
      agentId: 'pi',
      skillId: 'novel',
      stage: 'writing',
      conversationId: 'conv-inline-test',
    });
    run.status = 'running';
    try {
      const res = await post({ chapter: 1, action: 'polish', selection: '被选中的片段。' });
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('run-in-progress');
      expect(body.runId).toBe(run.id);
      expect(callPiOnce).not.toHaveBeenCalled();
    } finally {
      finishRun(run, 'canceled');
      await run.finished;
    }
  });

  it('模型调用失败 → 500 带 error 消息', async () => {
    vi.mocked(callPiOnce).mockImplementation(async () => {
      throw new Error('AI 调用超时，已中止当前任务');
    });
    const res = await post({ chapter: 1, action: 'polish', selection: '被选中的片段。', selectionStart: SEL_START });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('AI 调用超时');
  });

  it('模型返回空白 → 500', async () => {
    vi.mocked(callPiOnce).mockImplementation(async () => '  \n ');
    const res = await post({ chapter: 1, action: 'polish', selection: '被选中的片段。', selectionStart: SEL_START });
    expect(res.status).toBe(500);
    expect(callPiOnce).toHaveBeenCalled();
  });
});
