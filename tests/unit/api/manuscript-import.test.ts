// @vitest-environment node
// EPUB 解析/构造走 fflate；jsdom 环境的跨 realm Uint8Array 会让 instanceof 失效。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import apiApp from '../../../src/api-app';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, chapters as chaptersTable } from '../../../src/db/schema';
import { generateId } from '../../../src/utils/id';
import { createRun, finishRun } from '../../../src/agent/run';

/**
 * 「导入手稿」API 契约：
 * - preview 只读（不落章节、不建 git）
 * - commit 写入第N章.md + chapter-status.json + config，并 resync DB
 * - run 在途 409；已有章节默认 409 chapters-exist，确认后可覆盖
 * - 标题绝不参与文件路径
 */
describe('导入手稿 API', () => {
  let tmpDir: string;
  let projectId: string;
  let chaptersDir: string;

  const sampleChapters = [
    { title: '少年', content: '少年不识愁滋味。'.repeat(20) },
    { title: '重逢', content: '重逢何必曾相识。'.repeat(20) },
  ];

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manuscript-import-'));
    chaptersDir = path.join(tmpDir, '.novel', 'chapters');
    fs.mkdirSync(chaptersDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.novel', 'config.json'),
      JSON.stringify({ title: '测试书', genre: 'general', chapterCount: 0, targetWords: 0 }),
    );
    projectId = generateId('proj_');
    await db.insert(projects).values({
      id: projectId,
      title: '测试书',
      path: tmpDir,
      genre: 'general',
      targetWords: 100000,
      chapterCount: 20,
      perspective: 'third-person',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.delete(chaptersTable).where(eq(chaptersTable.projectId, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preview 切章但不写任何文件', async () => {
    const text = [
      '第一章 少年',
      '少年正文甲。',
      '',
      '第二章 重逢',
      '重逢正文乙。',
    ].join('\n');

    const res = await apiApp.request('/api/projects/import-manuscript/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, filename: 'book.txt' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chapterCount).toBe(2);
    expect(data.chapters[0]).toMatchObject({ number: 1, title: '少年' });
    expect(data.chapters[0].preview).toContain('少年正文甲');
    expect(typeof data.chapters[0].charCount).toBe('number');
    expect(data.mode).toBe('headings');

    // 无副作用：章节目录仍为空，也没有初始化 git
    expect(fs.readdirSync(chaptersDir)).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(false);
  });

  it('preview 支持 EPUB（base64 上传）', async () => {
    const opf = `<?xml version="1.0"?><package><metadata><dc:title>测试书</dc:title></metadata>
      <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1"/></spine></package>`;
    const epub = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
      'content.opf': strToU8(opf),
      'c1.xhtml': strToU8('<html><body><h1>第一章 少年</h1><p>来自 EPUB 的正文。</p></body></html>'),
    });

    const res = await apiApp.request('/api/projects/import-manuscript/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'book.epub',
        contentBase64: Buffer.from(epub).toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.format).toBe('epub');
    expect(data.suggestedTitle).toBe('测试书');
    expect(data.chapters).toHaveLength(1);
    expect(data.chapters[0].content).toContain('来自 EPUB 的正文');
  });

  it('preview 对 GBK 书稿回退 GB18030 解码', async () => {
    const gbk = Buffer.from([
      181, 218, 210, 187, 213, 194, 32, 196, 227, 186, 195, 10,
      213, 226, 202, 199, 213, 253, 206, 196, 161, 163, 10,
      181, 218, 182, 254, 213, 194, 32, 212, 217, 188, 251, 10,
      189, 225, 202, 248, 161, 163,
    ]);
    const res = await apiApp.request('/api/projects/import-manuscript/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'gbk.txt', contentBase64: gbk.toString('base64') }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.encoding).toBe('gb18030');
    expect(data.warnings.some((w: string) => w.includes('GB18030'))).toBe(true);
    expect(data.chapters).toHaveLength(2);
    expect(data.chapters[0].content).toContain('这是正文');
  });

  it('preview 拒绝空内容与 PDF', async () => {
    const empty = await apiApp.request('/api/projects/import-manuscript/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(empty.status).toBe(400);

    const pdf = await apiApp.request('/api/projects/import-manuscript/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'book.pdf',
        contentBase64: Buffer.from('%PDF-1.4 fake').toString('base64'),
      }),
    });
    expect(pdf.status).toBe(400);
    expect((await pdf.json()).error).toContain('PDF');
  });

  it('commit 写入章节、状态、config 并同步 DB', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: sampleChapters, finalized: true }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.imported).toBe(2);
    expect(data.statusCounts.finalized).toBe(2);

    const ch1 = fs.readFileSync(path.join(chaptersDir, '第1章.md'), 'utf-8');
    expect(ch1.startsWith('# 第1章 少年')).toBe(true);
    expect(ch1).toContain('少年不识愁滋味');
    const ch2 = fs.readFileSync(path.join(chaptersDir, '第2章.md'), 'utf-8');
    expect(ch2.startsWith('# 第2章 重逢')).toBe(true);

    // 章节状态落盘（事实源）
    const statusFile = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel', 'chapter-status.json'), 'utf-8'));
    expect(statusFile).toEqual({ '1': 'finalized', '2': 'finalized' });

    // config
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel', 'config.json'), 'utf-8'));
    expect(config.chapterCount).toBe(2);
    expect(config.sourceImported).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.novel', 'config.json.bak'))).toBe(true);

    // DB 项目 + 章节缓存
    const [projectRow] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(projectRow.chapterCount).toBe(2);
    // 定稿导入后阶段只前进：2 章 → sample
    expect(projectRow.currentStage).toBe('sample');
    const rows = await db.select().from(chaptersTable).where(eq(chaptersTable.projectId, projectId));
    expect(rows.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows.every((r) => r.status === 'finalized')).toBe(true);

    // git 快照已创建（双分支：draft 为当前分支）
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
    expect(data.snapshot.skipped).toBe(false);
  });

  it('run 在途时 commit 返回 409 run-in-progress', async () => {
    const run = createRun({
      projectId,
      agentId: 'claude',
      skillId: 'novel',
      stage: 'writing',
      conversationId: 'conv_manuscript_lock',
    });
    run.status = 'running';
    try {
      const res = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapters: sampleChapters }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('run-in-progress');
      // 没有写盘
      expect(fs.readdirSync(chaptersDir)).toEqual([]);
    } finally {
      finishRun(run, 'succeeded');
    }
  });

  it('已有章节默认拒绝覆盖，确认后备份并覆盖', async () => {
    const existing = path.join(chaptersDir, '第1章.md');
    fs.writeFileSync(existing, '# 第1章 旧稿\n\n旧正文内容\n');

    const conflictRes = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: sampleChapters }),
    });
    expect(conflictRes.status).toBe(409);
    const conflict = await conflictRes.json();
    expect(conflict.error).toBe('chapters-exist');
    expect(conflict.existingChapters).toContain(1);
    expect(fs.readFileSync(existing, 'utf-8')).toContain('旧稿');

    const overwriteRes = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: sampleChapters, overwrite: true }),
    });
    expect(overwriteRes.status).toBe(201);
    const data = await overwriteRes.json();
    expect(data.overwritten).toBe(1);
    expect(fs.readFileSync(`${existing}.bak`, 'utf-8')).toContain('旧稿');
    expect(fs.readFileSync(existing, 'utf-8')).toContain('少年不识愁滋味');
  });

  it('标题不参与文件路径（防目录穿越）', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapters: [
          { title: '../../etc/passwd', content: '第一段正文。'.repeat(20) },
          { title: '..\\..\\evil\n# 注入标题', content: '第二段正文。'.repeat(20) },
        ],
      }),
    });
    expect(res.status).toBe(201);

    expect(fs.readdirSync(chaptersDir).sort()).toEqual(['第1章.md', '第2章.md']);
    expect(fs.existsSync(path.join(tmpDir, 'etc'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'evil'))).toBe(false);

    const ch1 = fs.readFileSync(path.join(chaptersDir, '第1章.md'), 'utf-8');
    const firstLine = ch1.split('\n')[0];
    expect(firstLine).toBe('# 第1章 ../../etc/passwd');
    // 换行注入被折叠为单行标题，不会产生第二个 markdown 标题行
    const ch2 = fs.readFileSync(path.join(chaptersDir, '第2章.md'), 'utf-8');
    expect(ch2.split('\n')[0]).toBe('# 第2章 ..\\..\\evil # 注入标题');
  });

  it('正文开头的 Markdown 小节标题不会被误删', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapters: [{ title: '风起', content: '## 小节一\n' + '正文内容。'.repeat(30) }],
      }),
    });
    expect(res.status).toBe(201);
    const content = fs.readFileSync(path.join(chaptersDir, '第1章.md'), 'utf-8');
    expect(content.split('\n')[0]).toBe('# 第1章 风起');
    expect(content).toContain('## 小节一');
  });

  it('正文不足 100 字不冒充定稿', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapters: [{ title: '短章', content: '短短一句话。' }],
        finalized: true,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.statusCounts.draft).toBe(1);
    expect(data.warnings.some((w: string) => w.includes('不足 100 字'))).toBe(true);
    const statusFile = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel', 'chapter-status.json'), 'utf-8'));
    expect(statusFile).toEqual({ '1': 'draft' });
  });

  it('finalized=false 全部按草稿落盘', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: sampleChapters, finalized: false }),
    });
    expect(res.status).toBe(201);
    const statusFile = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel', 'chapter-status.json'), 'utf-8'));
    expect(statusFile).toEqual({ '1': 'draft', '2': 'draft' });
  });

  it('参数校验：空数组 / 空正文 / 项目不存在', async () => {
    const empty = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: [] }),
    });
    expect(empty.status).toBe(400);

    const blank = await apiApp.request(`/api/projects/${projectId}/import-manuscript/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: [{ title: '空', content: '   ' }] }),
    });
    expect(blank.status).toBe(400);

    const missing = await apiApp.request('/api/projects/proj_nonexistent_xyz/import-manuscript/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: sampleChapters }),
    });
    expect(missing.status).toBe(404);
  });
});
