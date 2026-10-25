// @vitest-environment node
/**
 * P1-a 集成证明：写作产出 run 成功后 finalizePiRun 自动提取 canon 并写回。
 * 仿 pi-run.test.ts：假 OpenAI 端点驱动内置 Pi 写第5章正文；
 * 提取调用（prompt 含「一致性台账的维护者」）返回围栏 JSON。
 * 同时覆盖 canonAutoExtract=false 关闭开关。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../src/db/drizzle';
import { projects, userSettings } from '../../src/db/schema';
import apiApp from '../../src/api-app';
import { getRun } from '../../src/agent/run';
import { readCanon } from '../../src/shared/canon';
import { PI_SETTING_KEYS } from '../../src/agent/pi/config';

let homeDir: string;
let server: http.Server;
let port = 0;

const CHAPTER_FILE = '.novel/chapters/第5章.md';
const CHAPTER_BODY = [
  '第5章 风雪夜',
  '',
  '暮色四合，沈青梧踏着积雪走进北境孤城的城门。守城的老兵认出她斗篷下的旧伤，默默放行。',
  '药庐的炉火尚未熄灭，她摊开从幽州军带回的军报，指尖在“主帅阵亡”四个字上停了许久。',
  '窗外风声呜咽，像是谁在低声哭泣。她想起师父临别时的叮嘱：北境的雪，从来不只是雪。',
  '',
].join('\n');

const EXTRACT_REPLY = '```json\n'
  + '{"entities":[{"name":"沈青梧","type":"character","description":"北境药师，左臂有旧伤"}],'
  + '"facts":[{"subject":"沈青梧","predicate":"效力于","object":"幽州军"}],'
  + '"knowledge":{"沈青梧":{"knows":["主帅已阵亡"],"doesNotKnow":["幕后主使身份"]}}}\n'
  + '```';

async function setSetting(key: string, value: string) {
  await db.delete(userSettings).where(eq(userSettings.key, key));
  await db.insert(userSettings).values({
    id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key,
    value,
  });
}

function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = (() => { try { return JSON.parse(body); } catch { return {}; } })();
    const messages: Array<{ role?: string }> = Array.isArray(payload.messages) ? payload.messages : [];
    const hasToolResult = messages.some((m) => m.role === 'tool' || m.role === 'toolResult');
    const isCanonExtraction = body.includes('一致性台账的维护者');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-canon', object: 'chat.completion.chunk', created: Date.now(), model: 'fake-model' };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (isCanonExtraction) {
      // finalizePiRun 的 canon 提取调用：返回围栏 JSON（P1-a 默认通道 callPiOnce）
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: EXTRACT_REPLY }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else if (!hasToolResult) {
      // 主 run 第一跳：写第5章正文
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
      send({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write_ch5',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({ path: CHAPTER_FILE, content: CHAPTER_BODY }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '第5章已完成。' }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

beforeAll(async () => {
  await ensureDbReady();
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-auto-home-'));
  process.env.OPEN_NOVEL_HOME = homeDir;
  server = http.createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server address missing');
  port = address.port;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.OPEN_NOVEL_HOME;
  await fs.rm(homeDir, { recursive: true, force: true });
});

/** 建项目 + 配置 fake Pi 通道，返回 {projectId, dir}。 */
async function setupProject(id: string, extraConfig: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-auto-proj-'));
  await db.delete(projects).where(eq(projects.id, id));
  await db.insert(projects).values({
    id,
    title: `Canon Auto ${id}`,
    path: dir,
    genre: 'novel',
    targetWords: 1000,
    chapterCount: 5,
    currentStage: 'sample',
  });
  await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
  if (Object.keys(extraConfig).length > 0) {
    await fs.writeFile(path.join(dir, '.novel', 'config.json'), JSON.stringify(extraConfig), 'utf-8');
  }
  await setSetting(PI_SETTING_KEYS.provider, 'custom');
  await setSetting(PI_SETTING_KEYS.model, 'fake-model');
  await setSetting(PI_SETTING_KEYS.api, 'openai-completions');
  await setSetting(PI_SETTING_KEYS.apiKey, 'local');
  await setSetting(PI_SETTING_KEYS.baseUrl, `http://127.0.0.1:${port}/v1`);
  return { dir };
}

async function teardownProject(id: string, dir: string) {
  await db.delete(projects).where(eq(projects.id, id));
  await fs.rm(dir, { recursive: true, force: true });
}

async function startSampleRun(projectId: string): Promise<string> {
  const res = await apiApp.request('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      agentId: 'pi',
      stage: 'sample',
      message: '写第5章',
      skillId: 'novel',
    }),
  });
  expect(res.status).toBe(201);
  const { runId } = await res.json() as { runId: string };
  return runId;
}

describe('finalizePiRun 自动 canon 提取（P1-a）', () => {
  it('sample run 成功后自动提取写回台账并 emit canon-update', async () => {
    const id = 'canon_auto_on';
    const { dir } = await setupProject(id);
    try {
      const runId = await startSampleRun(id);
      const run = getRun(runId);
      expect(run).toBeTruthy();
      await run!.finished;

      // 事件链：提取中 status → canon-update（ok/applied/计数）→ 汇总 status
      const agentEvents = (await run!.stream.replay(0))
        .filter((e) => e.event === 'agent')
        .map((e) => e.data as Record<string, unknown>);
      expect(agentEvents.some((e) => e.type === 'status' && String(e.label).includes('canon 提取中'))).toBe(true);
      const updates = agentEvents.filter((e) => e.type === 'canon-update');
      expect(updates).toHaveLength(1);
      expect(updates[0].ok).toBe(true);
      expect(updates[0].applied).toBe(true);
      expect(updates[0].chapter).toBe(5);
      expect(updates[0].entities).toBe(1);
      expect(updates[0].facts).toBe(1);
      expect(updates[0].knowledge).toBe(1);
      expect(agentEvents.some((e) => e.type === 'status' && String(e.label).includes('canon 已更新'))).toBe(true);

      // 台账 + 变更日志落盘（提取在 createSnapshot 之前完成）
      const ledger = await readCanon(dir);
      expect(ledger.entities.map((e) => e.name)).toContain('沈青梧');
      expect(ledger.facts.some((f) => f.subject === '沈青梧' && f.predicate === '效力于')).toBe(true);
      expect(ledger.knowledge['沈青梧']?.knows).toContain('主帅已阵亡');
      const log = await fs.readFile(path.join(dir, '.novel', 'canon', 'changes.jsonl'), 'utf-8');
      expect(JSON.parse(log.trim()).chapter).toBe(5);
    } finally {
      await teardownProject(id, dir);
    }
  }, 60_000);

  it('canonAutoExtract=false 时跳过提取', async () => {
    const id = 'canon_auto_off';
    const { dir } = await setupProject(id, { canonAutoExtract: false });
    try {
      const runId = await startSampleRun(id);
      const run = getRun(runId);
      await run!.finished;

      const agentEvents = (await run!.stream.replay(0))
        .filter((e) => e.event === 'agent')
        .map((e) => e.data as Record<string, unknown>);
      expect(agentEvents.some((e) => e.type === 'canon-update')).toBe(false);
      // 章节正文仍正常产出，只是不提取
      const body = await fs.readFile(path.join(dir, CHAPTER_FILE), 'utf-8');
      expect(body).toContain('沈青梧');
      expect((await readCanon(dir)).entities).toHaveLength(0);
      await expect(fs.access(path.join(dir, '.novel', 'canon', 'changes.jsonl'))).rejects.toThrow();
    } finally {
      await teardownProject(id, dir);
    }
  }, 60_000);
});
