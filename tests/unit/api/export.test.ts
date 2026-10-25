// @vitest-environment node
// 导出是纯 Node 逻辑（fflate 构造 ZIP），且 fflate 的 instanceof 判定在 jsdom
// 环境下会因 TextEncoder 跨 realm 失效。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq, and } from 'drizzle-orm';
import { unzipSync, strFromU8, type Unzipped } from 'fflate';
import { JSDOM } from 'jsdom';
import apiApp from '../../../src/api-app';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, chapters } from '../../../src/db/schema';
import { generateId } from '../../../src/utils/id';

vi.mock('../../../src/agent/registry', () => ({ getAgentDef: () => ({ id: 'claude', label: 'Claude' }) }));
vi.mock('../../../src/agent/detection', () => ({ detectAgents: async () => [] }));

/**
 * EPUB/DOCX 导出契约：
 * - EPUB 3：mimetype 为 ZIP 首条且不压缩；container/OPF/spine/nav 可解析；每章一个 XHTML；
 *   正文 & < > " ' 正确转义；spine 章数与真实章节数一致。
 * - DOCX：合法 ZIP，含 word/document.xml；标题页 + Heading 1 + 中文首行缩进。
 * - 只读：不修改正文/归档文件；degraded/ 与 *.degraded.md 不进入导出。
 */

const PROJECT_TITLE = '导出测试小说';

let tmpDir: string;
let projectId: string;
let novelDir: string;

// node 环境没有全局 DOMParser；用 jsdom 实例解析，仍能验证 XML 合法性与结构。
const domWindow = new JSDOM('').window as unknown as {
  DOMParser: new () => { parseFromString(text: string, type: string): Document };
};

function xmlDoc(xml: string): Document {
  const doc = new domWindow.DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror').length).toBe(0);
  return doc;
}

function zipEntryText(zip: Unzipped, name: string): string {
  const entry = zip[name];
  expect(entry, `missing zip entry: ${name}`).toBeDefined();
  return strFromU8(entry);
}

/** ZIP 第一条本地文件头必须指向 mimetype，且压缩方法为 0（stored）。 */
function assertFirstZipEntryStored(bytes: Uint8Array, name: string): void {
  expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  const method = bytes[8] | (bytes[9] << 8);
  expect(method).toBe(0);
  const nameLength = bytes[26] | (bytes[27] << 8);
  const entryName = strFromU8(bytes.slice(30, 30 + nameLength));
  expect(entryName).toBe(name);
}

beforeEach(async () => {
  await ensureDbReady();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-export-test-'));
  novelDir = path.join(tmpDir, '.novel');
  const chaptersDir = path.join(novelDir, 'chapters');
  await fs.mkdir(chaptersDir, { recursive: true });
  await fs.mkdir(path.join(novelDir, 'degraded'), { recursive: true });

  await fs.writeFile(
    path.join(chaptersDir, '第1章.md'),
    '第一段 & < > "双引号" \'单引号\'，中文正文。\n第二段继续。\n',
  );
  await fs.writeFile(path.join(chaptersDir, '第2章.md'), '第二章正文：风雪夜归人。\n');
  // 质检归档章节：隔离目录 + 旧版就地归档，均不得进入导出。
  await fs.writeFile(path.join(novelDir, 'degraded', '第3章.md'), '这是质检归档内容，不应导出。\n');
  await fs.writeFile(path.join(chaptersDir, '第4章.degraded.md'), '旧版就地归档内容，不应导出。\n');

  projectId = generateId('proj_');
  await db.insert(projects).values({
    id: projectId,
    title: PROJECT_TITLE,
    path: tmpDir,
    genre: 'wuxia',
    theme: '侠义与成长',
  });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('EPUB 导出', () => {
  it('mimetype 首条不压缩，OPF/spine/nav 可解析，章节数与转义正确', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/export/epub`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/epub+zip');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain("filename*=UTF-8''");
    const star = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    expect(star && decodeURIComponent(star)).toBe(`${PROJECT_TITLE}.epub`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    assertFirstZipEntryStored(bytes, 'mimetype');
    const zip = unzipSync(bytes);
    expect(strFromU8(zip.mimetype)).toBe('application/epub+zip');

    const container = zipEntryText(zip, 'META-INF/container.xml');
    expect(container).toContain('full-path="OEBPS/content.opf"');

    const opf = zipEntryText(zip, 'OEBPS/content.opf');
    const opfDoc = xmlDoc(opf);
    expect(opfDoc.getElementsByTagName('dc:language')[0]?.textContent).toBe('zh');
    expect(opfDoc.getElementsByTagName('dc:title')[0]?.textContent).toBe(PROJECT_TITLE);

    const manifest = new Map<string, string>();
    for (const item of Array.from(opfDoc.getElementsByTagName('item'))) {
      manifest.set(item.getAttribute('id') ?? '', item.getAttribute('href') ?? '');
    }
    const spine = Array.from(opfDoc.getElementsByTagName('itemref'))
      .map((item) => item.getAttribute('idref') ?? '');
    expect(spine).toEqual(['chapter-1', 'chapter-2']);
    expect(manifest.get('nav')).toBe('nav.xhtml');
    for (const idref of spine) {
      const href = manifest.get(idref);
      expect(href).toBeTruthy();
      expect(zip[`OEBPS/${href}`], `missing chapter entry for ${idref}`).toBeDefined();
    }

    const chapter = zipEntryText(zip, 'OEBPS/text/chapter-1.xhtml');
    expect(chapter).toContain('&amp;');
    expect(chapter).toContain('&lt;');
    expect(chapter).toContain('&gt;');
    expect(chapter).toContain('&quot;');
    expect(chapter).toContain('&apos;');
    expect(chapter).toContain('中文正文');
    xmlDoc(chapter);

    const nav = zipEntryText(zip, 'OEBPS/nav.xhtml');
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('text/chapter-1.xhtml');
    expect(nav).toContain('text/chapter-2.xhtml');

    // 归档章节（隔离目录 + 旧版就地归档）必须排除。
    expect(Object.keys(zip).filter((name) => name.startsWith('OEBPS/text/chapter-'))).toHaveLength(2);
    const allText = Object.keys(zip)
      .filter((name) => name.endsWith('.xhtml'))
      .map((name) => zipEntryText(zip, name))
      .join('\n');
    expect(allText).not.toContain('质检归档内容');
    expect(allText).not.toContain('旧版就地归档内容');
  });

  it('正文自带章节标题时不重复输出（导入手稿保留原标题目录）', async () => {
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第1章.md'),
      '# 第1章 起风\n\n第一章正文。\n',
    );
    // DB 标题也保留了原标题，旧实现会导出「第 1 章 第1章 起风」+ 二级标题。
    await db.update(chapters)
      .set({ title: '第1章 起风' })
      .where(and(eq(chapters.projectId, projectId), eq(chapters.number, 1)));

    const res = await apiApp.request(`/api/projects/${projectId}/export/epub`);
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const xhtml = zipEntryText(zip, 'OEBPS/text/chapter-1.xhtml');
    expect(xhtml).toContain('<h1>第 1 章 起风</h1>');
    expect(xhtml.match(/<h1>/g)).toHaveLength(1);
    expect(xhtml).not.toContain('第 1 章 第1章');
    expect(xhtml).not.toContain('<h2>');
    expect(xhtml).toContain('第一章正文。');
  });

  it('默认仅正文；?scope=full 才附带设定资料', async () => {
    await fs.writeFile(path.join(novelDir, 'concept.md'), '# 故事概念\n\n一个关于侠义的故事。\n');

    const defaultRes = await apiApp.request(`/api/projects/${projectId}/export/epub`);
    const defaultZip = unzipSync(new Uint8Array(await defaultRes.arrayBuffer()));
    const defaultSpine = Array.from(
      xmlDoc(zipEntryText(defaultZip, 'OEBPS/content.opf')).getElementsByTagName('itemref'),
    );
    expect(defaultSpine).toHaveLength(2);

    const fullRes = await apiApp.request(`/api/projects/${projectId}/export/epub?scope=full`);
    const fullZip = unzipSync(new Uint8Array(await fullRes.arrayBuffer()));
    const fullSpine = Array.from(
      xmlDoc(zipEntryText(fullZip, 'OEBPS/content.opf')).getElementsByTagName('itemref'),
    );
    expect(fullSpine).toHaveLength(3);
    expect(zipEntryText(fullZip, 'OEBPS/text/front-concept.xhtml')).toContain('一个关于侠义的故事');
  });

  it('缺章仍进入 spine 但标注占位，并写入警告头', async () => {
    // 删除第 2 章、补一个第 5 章：resync 后 1 与 5 之间形成章号空洞。
    await fs.rm(path.join(novelDir, 'chapters', '第2章.md'));
    await fs.writeFile(path.join(novelDir, 'chapters', '第5章.md'), '第五章正文。\n');

    const res = await apiApp.request(`/api/projects/${projectId}/export/epub`);
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const opfDoc = xmlDoc(zipEntryText(zip, 'OEBPS/content.opf'));
    const spine = Array.from(opfDoc.getElementsByTagName('itemref'))
      .map((item) => item.getAttribute('idref'));
    expect(spine).toEqual(['chapter-1', 'chapter-2', 'chapter-5']);
    expect(zipEntryText(zip, 'OEBPS/text/chapter-2.xhtml')).toContain('章节缺失');
    const warnings = decodeURIComponent(res.headers.get('x-export-warnings') ?? '');
    expect(warnings).toContain('第2章文件缺失');
  });
});

describe('DOCX 导出', () => {
  it('是合法 ZIP 且包含标题页、Heading 1、首行缩进与转义正文', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/export/docx`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const disposition = res.headers.get('content-disposition') ?? '';
    const star = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    expect(star && decodeURIComponent(star)).toBe(`${PROJECT_TITLE}.docx`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const zip = unzipSync(bytes);

    const documentXml = zipEntryText(zip, 'word/document.xml');
    const doc = xmlDoc(documentXml);
    const text = Array.from(doc.getElementsByTagName('w:t'))
      .map((node) => node.textContent ?? '')
      .join('');
    expect(text).toContain(PROJECT_TITLE);
    expect(text).toContain('第 1 章');
    expect(text).toContain('第 2 章');
    // 解析后的纯文本还原原始特殊字符（写入前已实体转义）
    expect(text).toContain('第一段 & < > "双引号" \'单引号\'，中文正文。');
    expect(documentXml).toContain('&amp;');
    expect(documentXml).toContain('&lt;');
    expect(documentXml).toContain('&quot;');

    const headingUses = documentXml.match(/<w:pStyle w:val="Heading1"\/>/g) ?? [];
    expect(headingUses).toHaveLength(2);
    expect(documentXml).toContain('<w:pStyle w:val="Title"/>');

    const styles = zipEntryText(zip, 'word/styles.xml');
    expect(styles).toContain('w:firstLineChars="200"');
    expect(styles).toContain('w:styleId="Heading1"');
    expect(documentXml).toContain('w:firstLineChars="200"');

    expect(Object.keys(zip)).toContain('[Content_Types].xml');
    expect(zipEntryText(zip, 'word/document.xml')).not.toContain('质检归档内容');
    expect(zipEntryText(zip, 'word/document.xml')).not.toContain('旧版就地归档内容');
  });
});

describe('平台发布文本导出', () => {
  it('四平台 target 返回 text/plain，排版符合平台规则（快照断言）', async () => {
    const responses = await Promise.all(
      (['qidian', 'fanqie', 'qimao', 'jinjiang'] as const).map(
        (target) => apiApp.request(`/api/projects/${projectId}/export/publish?target=${target}&chapter=1`),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    }
    const [qidian, fanqie, qimao, jinjiang] = await Promise.all(responses.map((r) => r.text()));

    // 第1章正文（setup 写入）两行两段，DB 无标题 → 章名只有编号
    expect(qidian).toBe('第1章\n\n第一段 & < > "双引号" \'单引号\'，中文正文。\n\n第二段继续。');
    expect(jinjiang).toBe(qidian);
    expect(fanqie).toBe(`第1章\n\n\n第一段 & < > "双引号" \'单引号\'，中文正文。\n\n第二段继续。`);
    expect(qimao).toBe('第1章\n\n第一段 & < > "双引号" \'单引号\'，中文正文。\n第二段继续。');

    const disposition = responses[0].headers.get('content-disposition') ?? '';
    expect(decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? ''))
      .toBe(`${PROJECT_TITLE}-qidian-第1章.txt`);
  });

  it('缺省 chapter 合并全本，章节间按平台空行衔接', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/export/publish?target=qimao`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('第1章\n\n第一段 & < > "双引号" \'单引号\'，中文正文。\n第二段继续。\n\n第2章\n\n第二章正文：风雪夜归人。');
  });

  it('无效 target 400；不存在的章号 404；归档章节不在可导出范围', async () => {
    const bad = await apiApp.request(`/api/projects/${projectId}/export/publish?target=zongheng`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('zongheng');

    const degraded = await apiApp.request(`/api/projects/${projectId}/export/publish?target=qidian&chapter=3`);
    expect(degraded.status).toBe(404);
    expect(((await degraded.json()) as { error: string }).error).toContain('第3章');
  });
});

describe('敏感词扫描', () => {
  it('逐章扫描返回命中/计数/样本，合并项目级词表，排除归档章节', async () => {
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第1章.md'),
      '# 第1章 风起\n\n城东的赌场彻夜灯火，赌场外有人私藏枪支。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第2章.md'),
      '# 第2章 夜行\n\n他体内灵气紊乱，提剑而去。\n',
    );
    await fs.writeFile(path.join(novelDir, 'degraded', '第3章.md'), '这家赌场已停业。\n');
    await fs.writeFile(
      path.join(novelDir, 'sensitive-words.txt'),
      '# 项目级词表\n灵气紊乱\n',
    );

    const res = await apiApp.request(`/api/projects/${projectId}/export/sensitive-scan`);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      totalHits: number;
      hits: Array<{ word: string; count: number; samples: Array<{ chapter: number | null; index: number; context: string }> }>;
      extraWordCount: number;
      chapterCounts: Array<{ chapter: number; count: number }>;
    };

    expect(data.totalHits).toBe(4); // 赌场×2 + 私藏枪支 + 灵气紊乱
    expect(data.extraWordCount).toBe(1);
    const byWord = new Map(data.hits.map((hit) => [hit.word, hit]));
    expect(byWord.get('赌场')?.count).toBe(2);
    expect(byWord.get('赌场')?.samples[0].chapter).toBe(1);
    expect(byWord.get('赌场')?.samples[0].context).toContain('城东的赌场彻夜灯火');
    expect(byWord.get('私藏枪支')?.count).toBe(1);
    expect(byWord.get('灵气紊乱')?.count).toBe(1); // 项目级自定义词
    expect(data.chapterCounts).toEqual([{ chapter: 1, count: 3 }, { chapter: 2, count: 1 }]);
    // 归档章节的命中不计入
    expect(data.hits.some((hit) => hit.samples.some((s) => s.chapter === 3))).toBe(false);
  });

  it('干净文本零命中', async () => {
    await fs.writeFile(path.join(novelDir, 'chapters', '第1章.md'), '风平浪静，岁月安然。\n');
    await fs.writeFile(path.join(novelDir, 'chapters', '第2章.md'), '第二段平静的正文。\n');
    const res = await apiApp.request(`/api/projects/${projectId}/export/sensitive-scan`);
    expect(res.status).toBe(200);
    const data = await res.json() as { totalHits: number; hits: unknown[] };
    expect(data.totalHits).toBe(0);
    expect(data.hits).toEqual([]);
  });

  it('项目不存在 404', async () => {
    const res = await apiApp.request('/api/projects/proj_missing/export/sensitive-scan');
    expect(res.status).toBe(404);
  });
});

describe('导出只读', () => {
  it('markdown/text/epub/docx 导出不修改项目文件', async () => {
    const files = [
      path.join(novelDir, 'chapters', '第1章.md'),
      path.join(novelDir, 'chapters', '第2章.md'),
      path.join(novelDir, 'chapters', '第4章.degraded.md'),
      path.join(novelDir, 'degraded', '第3章.md'),
    ];
    const snapshot = async () => {
      const entries: Array<{ file: string; content: string; mtime: number }> = [];
      for (const file of files) {
        const stat = await fs.stat(file);
        entries.push({ file, content: await fs.readFile(file, 'utf-8'), mtime: stat.mtimeMs });
      }
      return entries;
    };
    const before = await snapshot();
    const listingsBefore = await Promise.all([
      fs.readdir(path.join(novelDir, 'chapters')),
      fs.readdir(path.join(novelDir, 'degraded')),
    ]);

    for (const format of ['markdown', 'text', 'epub', 'docx']) {
      const res = await apiApp.request(`/api/projects/${projectId}/export/${format}`);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }

    expect(await snapshot()).toEqual(before);
    expect(await Promise.all([
      fs.readdir(path.join(novelDir, 'chapters')),
      fs.readdir(path.join(novelDir, 'degraded')),
    ])).toEqual(listingsBefore);
  });
});
