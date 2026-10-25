/**
 * 提示词预设 API 测试：/api/projects/:projectId/presets 在 api-app.ts 由主控统一挂载，
 * 这里按 foreshadows.test.ts 的方式本地 Hono 实例同参数名直挂路由测试（避免依赖挂载顺序）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import presetsRouter from '../../../src/api/routes/presets';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { createRun, finishRun } from '../../../src/agent/run';

const app = new Hono();
app.route('/api/projects/:projectId/presets', presetsRouter);

const PROJECT_ID = 'test_presets_1';
let tmpDir: string;
let skillDir: string;

function presetRoot(): string {
  return path.join(tmpDir, '.novel', 'prompt-presets');
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function createPresetViaApi(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await app.request(`/api/projects/${PROJECT_ID}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const data = await json(res);
  return (data.preset as { id: string });
}

beforeEach(async () => {
  await ensureDbReady();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-api-'));
  fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
  // 导入源：临时 SKILL.md（带 frontmatter）
  skillDir = path.join(tmpDir, 'plugin-src');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: wuxia-src\ndescription: 源技能\n---\n以金庸笔法为准。',
  );
  await db.delete(projects).where(eq(projects.id, PROJECT_ID)).catch(() => {});
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: '预设 API 测试',
    path: tmpDir,
    genre: 'general',
    chapterCount: 0,
  });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID)).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('预设 CRUD / 版本 / 绑定', () => {
  it('POST / 创建 → manifest 落盘；GET / 列表含 current/版本数/绑定阶段', async () => {
    const created = await createPresetViaApi({ name: '武侠文风', stage: 'writing', content: '多用短句。' });
    expect(created.id).toBe('wuxiawenfeng');
    expect(fs.existsSync(path.join(presetRoot(), created.id, 'manifest.json'))).toBe(true);

    await app.request(`/api/projects/${PROJECT_ID}/presets/bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'writing', presetId: created.id }),
    });

    const listRes = await app.request(`/api/projects/${PROJECT_ID}/presets`);
    expect(listRes.status).toBe(200);
    const data = await json(listRes);
    const presets = data.presets as Array<Record<string, unknown>>;
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      id: 'wuxiawenfeng', current: 1, versionCount: 1, boundStages: ['writing'],
    });
    expect((data.bindings as Record<string, string | null>).writing).toBe(created.id);
  });

  it('POST / 参数缺失或非法 → 400；项目不存在 → 404', async () => {
    const missName = await app.request(`/api/projects/${PROJECT_ID}/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(missName.status).toBe(400);

    const badJson = await app.request(`/api/projects/${PROJECT_ID}/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(badJson.status).toBe(400);

    const notFound = await app.request('/api/projects/ghost_project/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', content: 'x' }),
    });
    expect(notFound.status).toBe(404);
  });

  it('POST /:id/versions 追加版本（current 自动指向新版）；GET /:id 返回各版本全文', async () => {
    const { id } = await createPresetViaApi({ name: 'A', content: '第一版' });
    const res = await app.request(`/api/projects/${PROJECT_ID}/presets/${id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第二版', note: '加强' }),
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ version: { version: 2, note: '加强' } });

    const detailRes = await app.request(`/api/projects/${PROJECT_ID}/presets/${id}`);
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);
    expect(detail.manifest).toMatchObject({ current: 2 });
    const versions = detail.versions as Array<Record<string, string>>;
    expect(versions.map((v) => v.content.trim())).toEqual(['第一版', '第二版']);

    // 不存在的预设 404
    const missing = await app.request(`/api/projects/${PROJECT_ID}/presets/nope/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(missing.status).toBe(404);
  });

  it('PATCH /:id 切换 current / 改名；非法版本 → 400', async () => {
    const { id } = await createPresetViaApi({ name: '旧名', content: 'v1' });
    await app.request(`/api/projects/${PROJECT_ID}/presets/${id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'v2' }),
    });

    const patchRes = await app.request(`/api/projects/${PROJECT_ID}/presets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 1, name: '新名' }),
    });
    expect(patchRes.status).toBe(200);
    const data = await json(patchRes);
    expect(data.preset).toMatchObject({ current: 1, name: '新名' });

    const badPatch = await app.request(`/api/projects/${PROJECT_ID}/presets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 99 }),
    });
    expect(badPatch.status).toBe(400);
  });

  it('PUT /bindings 校验 stage 白名单与预设存在性', async () => {
    const ok = await app.request(`/api/projects/${PROJECT_ID}/presets/bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'sample', presetId: null }),
    });
    expect(ok.status).toBe(200);

    const badStage = await app.request(`/api/projects/${PROJECT_ID}/presets/bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'nope', presetId: null }),
    });
    expect(badStage.status).toBe(400);

    const ghost = await app.request(`/api/projects/${PROJECT_ID}/presets/bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'writing', presetId: 'ghost' }),
    });
    expect(ghost.status).toBe(400);
  });

  it('DELETE /:id 删除预设', async () => {
    const { id } = await createPresetViaApi({ name: 'A', content: 'x' });
    const res = await app.request(`/api/projects/${PROJECT_ID}/presets/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(presetRoot(), id))).toBe(false);
  });

  it('POST /import-skill 导入 SKILL.md（剥 frontmatter）；路径非法 → 400', async () => {
    const ok = await app.request(`/api/projects/${PROJECT_ID}/presets/import-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillPath: path.join(skillDir, 'SKILL.md'), stage: 'writing' }),
    });
    expect(ok.status).toBe(201);
    const data = await json(ok);
    expect(data.preset).toMatchObject({ name: 'wuxia-src', stage: 'writing', current: 1 });

    const relative = await app.request(`/api/projects/${PROJECT_ID}/presets/import-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillPath: 'plugins/x/SKILL.md' }),
    });
    expect(relative.status).toBe(400);

    const notMd = await app.request(`/api/projects/${PROJECT_ID}/presets/import-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillPath: path.join(skillDir, 'open-novel.json') }),
    });
    expect(notMd.status).toBe(400);

    const missingFile = await app.request(`/api/projects/${PROJECT_ID}/presets/import-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillPath: path.join(skillDir, 'nope.md') }),
    });
    expect(missingFile.status).toBe(400);
  });
});

describe('GET /preview 组装预览', () => {
  it('绑定预设后：prompt 含 preset:start/end 边界标记 + 预设内容 + token 估算', async () => {
    const { id } = await createPresetViaApi({ name: '文风预设', content: '多用短句，重意境。' });
    await app.request(`/api/projects/${PROJECT_ID}/presets/bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'writing', presetId: id }),
    });

    const res = await app.request(`/api/projects/${PROJECT_ID}/presets/preview?stage=writing`);
    expect(res.status).toBe(200);
    const data = await json(res);
    const prompt = data.prompt as string;
    expect(prompt).toContain('<!-- preset:start -->');
    expect(prompt).toContain('<!-- preset:end -->');
    // 边界标记之间包含预设正文与版本标注
    const start = prompt.indexOf('<!-- preset:start -->');
    const end = prompt.indexOf('<!-- preset:end -->');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const presetPart = prompt.slice(start, end);
    expect(presetPart).toContain('多用短句，重意境。');
    expect(presetPart).toContain('v1');
    expect(data.presetId).toBe(id);
    expect(data.version).toBe(1);
    expect(data.tokensApprox).toBeGreaterThan(0);
  });

  it('未绑定阶段：presetId 为 null，prompt 无预设标记', async () => {
    const res = await app.request(`/api/projects/${PROJECT_ID}/presets/preview?stage=writing`);
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.presetId).toBeNull();
    expect(data.version).toBeNull();
    expect(data.prompt as string).not.toContain('preset:start');
  });

  it('非 writing 阶段：上下文退化为 concept/world 示意层并带说明', async () => {
    fs.mkdirSync(path.join(tmpDir, '.novel', 'concept'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.novel', 'concept', 'core.md'), '# 核心概念\n废土修仙。');

    const res = await app.request(`/api/projects/${PROJECT_ID}/presets/preview?stage=concept`);
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.note).toBe('上下文层仅写作阶段完整，此处为示意');
    expect(data.prompt as string).toContain('废土修仙');
    expect(data.prompt as string).toContain('示意');
  });

  it('非法 stage → 400；项目不存在 → 404', async () => {
    const bad = await app.request(`/api/projects/${PROJECT_ID}/presets/preview?stage=ghost`);
    expect(bad.status).toBe(400);
    const none = await app.request(`/api/projects/${PROJECT_ID}/presets/preview`);
    expect(none.status).toBe(400);
    const ghostProject = await app.request('/api/projects/ghost_project/presets/preview?stage=writing');
    expect(ghostProject.status).toBe(404);
  });
});

describe('项目串行锁（run-in-progress）', () => {
  it('写操作 409，读操作放行（处理器正确 return 锁响应，而非 404）', async () => {
    const run = createRun({
      projectId: PROJECT_ID,
      agentId: 'claude',
      skillId: 'novel',
      stage: 'writing',
      conversationId: 'conv_presets_lock',
    });
    run.status = 'running';
    try {
      const post = await app.request(`/api/projects/${PROJECT_ID}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A', content: 'x' }),
      });
      expect(post.status).toBe(409);
      const body = await json(post);
      expect(body.error).toBe('run-in-progress');
      expect(body.runId).toBe(run.id);
      // 未落盘
      expect(fs.existsSync(presetRoot())).toBe(false);

      const bind = await app.request(`/api/projects/${PROJECT_ID}/presets/bindings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'writing', presetId: null }),
      });
      expect(bind.status).toBe(409);

      const importSkill = await app.request(`/api/projects/${PROJECT_ID}/presets/import-skill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillPath: path.join(skillDir, 'SKILL.md') }),
      });
      expect(importSkill.status).toBe(409);

      // 只读端点不受锁影响
      const list = await app.request(`/api/projects/${PROJECT_ID}/presets`);
      expect(list.status).toBe(200);
      const preview = await app.request(`/api/projects/${PROJECT_ID}/presets/preview?stage=writing`);
      expect(preview.status).toBe(200);
    } finally {
      finishRun(run, 'succeeded');
    }
  });
});
