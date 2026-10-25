// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, userSettings } from '../../../src/db/schema';
import apiApp from '../../../src/api-app';

const PROJECT_ID = 'context_preview_project';
let projectDir: string;

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

interface SectionRow {
  name: string;
  priority: number;
  tokens: number;
  kept: boolean;
  truncatedTo?: number;
}

interface PreviewBody {
  sections: SectionRow[];
  totalTokens: number;
  budgetTokens: number;
  prompt: string;
  chapter: number;
}

beforeEach(async () => {
  await ensureDbReady();
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-api-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  // 隔离其它测试写入的 Pi 窗口设置，锁定默认预算（128k×0.4 → 上限 48k）
  await db.delete(userSettings).where(eq(userSettings.key, 'pi_context_window'));
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: 'Context API',
    path: projectDir,
    genre: 'novel',
    targetWords: 1000,
    chapterCount: 3,
    currentStage: 'writing',
  });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(userSettings).where(eq(userSettings.key, 'pi_context_window'));
  await fs.rm(projectDir, { recursive: true, force: true });
});

/** 写一章有效正文（CJK ≥ 100，findNextUnwrittenChapter 才视为已写）。 */
async function writeChapter(num: number) {
  await fs.mkdir(path.join(projectDir, '.novel', 'chapters'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, '.novel', 'chapters', `第${num}章.md`),
    `# 第${num}章\n\n${'夜色渐深，主角握紧了手中的剑。'.repeat(12)}`,
    'utf-8',
  );
}

describe('context preview API', () => {
  it('GET /preview 返回分层 token 报告 + 组装后 prompt（chapter 缺省取下一章）', async () => {
    await writeChapter(1);
    await writeChapter(2);

    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/context/preview`);
    expect(res.status).toBe(200);
    const body = await json(res) as unknown as PreviewBody;

    // 两章已写 → 默认预览第 3 章
    expect(body.chapter).toBe(3);
    expect(Array.isArray(body.sections)).toBe(true);
    expect(typeof body.totalTokens).toBe('number');
    expect(body.budgetTokens).toBe(48_000);
    expect(body.prompt.startsWith('## Novel Context Layers')).toBe(true);
    // 报告条目字段齐全且带优先级
    for (const s of body.sections) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.priority).toBe('number');
      expect(typeof s.tokens).toBe('number');
      expect(typeof s.kept).toBe('boolean');
    }
    expect(body.sections.some((s) => s.kept)).toBe(true);
  });

  it('chapter 参数显式指定预览章号', async () => {
    await writeChapter(1);
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/context/preview?chapter=5`);
    expect(res.status).toBe(200);
    const body = await json(res) as unknown as PreviewBody;
    expect(body.chapter).toBe(5);
    // 第 5 章无大纲卡片也应有占位层（滚动摘要提示），prompt 仍完整
    expect(body.prompt).toContain('### 滚动摘要层');
  });

  it('非法 chapter 参数返回 400', async () => {
    expect((await apiApp.request(`/api/projects/${PROJECT_ID}/context/preview?chapter=0`)).status).toBe(400);
    expect((await apiApp.request(`/api/projects/${PROJECT_ID}/context/preview?chapter=abc`)).status).toBe(400);
  });

  it('项目不存在返回 404', async () => {
    const res = await apiApp.request('/api/projects/no-such-project/context/preview');
    expect(res.status).toBe(404);
  });

  it('pi_context_window 设置参与预算换算：min(窗口×0.4, 48k)', async () => {
    await db.insert(userSettings).values({ id: 'set_ctx_window', key: 'pi_context_window', value: '100000' });
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/context/preview`);
    expect(res.status).toBe(200);
    const body = await json(res) as unknown as PreviewBody;
    expect(body.budgetTokens).toBe(40_000); // 100k×0.4 < 48k 上限
  });

  it('空项目也可预览（无章节 → 默认第 1 章）', async () => {
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/context/preview`);
    expect(res.status).toBe(200);
    const body = await json(res) as unknown as PreviewBody;
    expect(body.chapter).toBe(1);
    expect(body.prompt).toContain('### 滚动摘要层');
  });
});
