/**
 * 行内评论 API 测试：/api/projects/:projectId/review/comments*（PR 式审阅）。
 * 按 presets.test.ts 的方式本地 Hono 实例同参数名直挂 review 路由（避免依赖挂载顺序）；
 * 只测 /comments 子路径——GET / 主体的 git 流程已在 review.test.ts 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import reviewRouter from '../../../src/api/routes/review';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { createRun, finishRun } from '../../../src/agent/run';

const app = new Hono();
app.route('/api/projects/:projectId/review', reviewRouter);

const PROJECT_ID = 'test_review_comments_1';
let tmpDir: string;

function commentsPath(): string {
  return path.join(tmpDir, '.novel', 'review', 'comments.jsonl');
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function addComment(body: Record<string, unknown>): Promise<Response> {
  return app.request(`/api/projects/${PROJECT_ID}/review/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchComment(id: string, resolved: boolean): Promise<Response> {
  return app.request(`/api/projects/${PROJECT_ID}/review/comments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  });
}

async function listComments(): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/projects/${PROJECT_ID}/review/comments`);
  expect(res.status).toBe(200);
  return json(res);
}

beforeEach(async () => {
  await ensureDbReady();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-comments-api-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID)).catch(() => {});
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: '评论 API 测试',
    path: tmpDir,
    genre: 'general',
    chapterCount: 0,
  });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID)).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET/POST /comments', () => {
  it('GET 空项目返回空列表与零计数', async () => {
    expect(await listComments()).toEqual({ comments: [], byFile: {}, unresolvedCount: 0 });
  });

  it('POST 创建评论（201）：trim 正文、落盘 jsonl、GET 按文件分组返回', async () => {
    const res = await addComment({ file: 'chapters/第1章.md', line: 5, body: '  这里悬念不足  ' });
    expect(res.status).toBe(201);
    const { comment } = await json(res);
    expect(comment).toMatchObject({
      file: 'chapters/第1章.md', line: 5, body: '这里悬念不足', resolved: false, author: 'user',
    });
    expect(fs.existsSync(commentsPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(commentsPath(), 'utf-8').trim()))
      .toMatchObject({ id: (comment as { id: string }).id, file: 'chapters/第1章.md' });

    await addComment({ file: 'concept.md', body: '设定问题' });

    const data = await listComments();
    expect((data.comments as unknown[])).toHaveLength(2);
    expect(data.unresolvedCount).toBe(2);
    const byFile = data.byFile as Record<string, unknown[]>;
    expect(Object.keys(byFile)).toEqual(['chapters/第1章.md', 'concept.md']);
    expect(byFile['chapters/第1章.md']).toHaveLength(1);
  });

  it('POST 参数校验：缺 file / 非法路径 / 空 body / 非法 line → 400', async () => {
    expect((await addComment({ body: 'x' })).status).toBe(400);
    expect((await addComment({ file: '   ', body: 'x' })).status).toBe(400);
    expect((await addComment({ file: ' x.md ', body: 'x' })).status).toBe(400);
    // 路径穿越/绝对路径/盘符/点段
    expect((await addComment({ file: '../../etc/passwd', body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'a/../b.md', body: 'x' })).status).toBe(400);
    expect((await addComment({ file: '/etc/passwd', body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'C:\\x.md', body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'a//b.md', body: 'x' })).status).toBe(400);
    // body
    expect((await addComment({ file: 'a.md', body: '' })).status).toBe(400);
    expect((await addComment({ file: 'a.md', body: '   ' })).status).toBe(400);
    expect((await addComment({ file: 'a.md' })).status).toBe(400);
    expect((await addComment({ file: 'a.md', body: 'x'.repeat(5001) })).status).toBe(400);
    // line：非正整数/字符串拒绝；null 视为省略
    expect((await addComment({ file: 'a.md', line: 0, body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'a.md', line: -3, body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'a.md', line: 1.5, body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'a.md', line: '3', body: 'x' })).status).toBe(400);
    expect((await addComment({ file: 'a.md', line: null, body: 'x' })).status).toBe(201);
    // 非法请求全部被拒，只有最后一个合法请求（line: null）落盘
    expect(fs.existsSync(commentsPath())).toBe(true);
    expect(fs.readFileSync(commentsPath(), 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('POST body 非法 JSON → 400', async () => {
    const res = await app.request(`/api/projects/${PROJECT_ID}/review/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('项目不存在 → GET/POST 404', async () => {
    const get = await app.request('/api/projects/ghost_proj/review/comments');
    expect(get.status).toBe(404);
    const post = await app.request('/api/projects/ghost_proj/review/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'a.md', body: 'x' }),
    });
    expect(post.status).toBe(404);
  });
});

describe('PATCH /comments/:id', () => {
  it('resolve → 覆盖记录且未解决数清零；unresolve → 恢复；未知 id → 404', async () => {
    const created = await json(await addComment({ file: 'a.md', line: 2, body: 'x' }));
    const id = (created.comment as { id: string }).id;

    const patch = await patchComment(id, true);
    expect(patch.status).toBe(200);
    expect((await json(patch)).comment).toMatchObject({ id, resolved: true });

    const data = await listComments();
    expect(data.unresolvedCount).toBe(0);

    const unpatch = await patchComment(id, false);
    expect((await json(unpatch)).comment).toMatchObject({ id, resolved: false });
    expect((await listComments()).unresolvedCount).toBe(1);

    const missing = await patchComment('nope1234', true);
    expect(missing.status).toBe(404);

    const badBody = await app.request(`/api/projects/${PROJECT_ID}/review/comments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: 'yes' }),
    });
    expect(badBody.status).toBe(400);
  });
});

describe('项目串行锁（run-in-progress）', () => {
  it('POST/PATCH 409（写 .novel 与 run 并发有覆盖风险）；GET 放行（纯元数据读）', async () => {
    // run 开始前先造一条评论供 PATCH 用
    const created = await json(await addComment({ file: 'a.md', body: 'x' }));
    const id = (created.comment as { id: string }).id;

    const run = createRun({
      projectId: PROJECT_ID,
      agentId: 'claude',
      skillId: 'novel',
      stage: 'writing',
      conversationId: 'conv_review_comments_lock',
    });
    run.status = 'running';
    try {
      const post = await addComment({ file: 'b.md', body: 'y' });
      expect(post.status).toBe(409);
      expect((await json(post)).error).toBe('run-in-progress');

      const patch = await patchComment(id, true);
      expect(patch.status).toBe(409);

      // 409 期间未追加任何新行
      expect(fs.readFileSync(commentsPath(), 'utf-8').trim().split('\n')).toHaveLength(1);

      // GET 放行：run 中仍可查看/统计评论
      const data = await listComments();
      expect(data.unresolvedCount).toBe(1);
      expect((data.comments as unknown[])).toHaveLength(1);
    } finally {
      finishRun(run, 'canceled');
    }

    // run 结束后恢复可写
    expect((await addComment({ file: 'b.md', body: 'y' })).status).toBe(201);
  });
});
