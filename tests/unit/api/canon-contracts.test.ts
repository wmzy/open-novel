// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, chapters } from '../../../src/db/schema';
import apiApp from '../../../src/api-app';

const PROJECT_ID = 'canon_api_project';
let projectDir: string;

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

beforeEach(async () => {
  await ensureDbReady();
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-api-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: 'Canon API',
    path: projectDir,
    genre: 'novel',
    targetWords: 1000,
    chapterCount: 3,
    currentStage: 'writing',
  });
  await db.insert(chapters).values({
    id: 'canon_ch_1',
    projectId: PROJECT_ID,
    number: 1,
    title: '第1章',
    wordCount: 1000,
    status: 'draft',
  });
  await fs.mkdir(path.join(projectDir, '.novel', 'chapters'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, '.novel', 'chapters', '第1章.md'),
    '# 第1章\n\n师父说：真凶身份不能告诉你。\n',
    'utf-8',
  );
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('canon API', () => {
  it('GET/PUT canon 与追加 changes', async () => {
    const empty = await json(await apiApp.request(`/api/projects/${PROJECT_ID}/canon`));
    expect(empty.canon).toMatchObject({ entities: [], facts: [] });

    const put = await apiApp.request(`/api/projects/${PROJECT_ID}/canon`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canon: {
          version: 1,
          entities: [{ id: 'e1', name: '林岚', type: 'character', aliases: ['阿岚'], status: 'active' }],
          facts: [],
          knowledge: {},
        },
      }),
    });
    expect(put.status).toBe(200);

    const changed = await json(await apiApp.request(`/api/projects/${PROJECT_ID}/canon/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapter: 2,
        changes: {
          facts: [{ subject: '林岚', predicate: 'location', object: '山门' }],
          knowledge: { 林岚: { knows: ['师父遇害'] } },
        },
      }),
    }));
    expect(changed.warnings).toEqual([]);
    const canon = changed.canon as { facts: Array<{ object: string }> };
    expect(canon.facts[0].object).toBe('山门');

    const log = await fs.readFile(path.join(projectDir, '.novel', 'canon', 'changes.jsonl'), 'utf-8');
    expect(log).toContain('山门');
  });
});

describe('contracts API + finalization gate', () => {
  it('PUT/GET/validate 合同，blocker 阻断定稿，force 留痕', async () => {
    const put = await apiApp.request(`/api/projects/${PROJECT_ID}/contracts/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pov: '林岚',
        cast: ['林岚', '师父'],
        mustReveal: ['密信'],
        mustNotReveal: ['真凶身份'],
        wordBudget: { target: 1000, min: 500, max: 1500 },
        status: 'frozen',
      }),
    });
    expect(put.status).toBe(200);

    const got = await json(await apiApp.request(`/api/projects/${PROJECT_ID}/contracts/1`));
    expect(got.contract).toMatchObject({ pov: '林岚', status: 'frozen' });

    const validation = await json(await apiApp.request(`/api/projects/${PROJECT_ID}/contracts/1/validate`, {
      method: 'POST',
    }));
    expect(validation.blockers).toBeGreaterThan(0);
    const findings = validation.findings as Array<{ code: string; severity: string }>;
    expect(findings.some((f) => f.code === 'pov-missing' && f.severity === 'blocker')).toBe(true);
    expect(findings.some((f) => f.code === 'must-not-reveal-present' && f.severity === 'blocker')).toBe(true);

    const blocked = await apiApp.request(`/api/projects/${PROJECT_ID}/chapters/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'finalized' }),
    });
    expect(blocked.status).toBe(409);
    const blockedBody = await json(blocked);
    expect(blockedBody.error).toBe('contract-gate');

    const forced = await apiApp.request(`/api/projects/${PROJECT_ID}/chapters/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'finalized', force: true, forceReason: '作者确认' }),
    });
    expect(forced.status).toBe(200);
    const overrides = await fs.readFile(path.join(projectDir, '.novel', 'canon', 'overrides.jsonl'), 'utf-8');
    expect(overrides).toContain('作者确认');
    expect(overrides).toContain('pov-missing');
  });
});
