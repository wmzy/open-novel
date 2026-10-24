import { Hono } from 'hono';
import type { Context } from 'hono';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { getActiveRunForProject } from '../../agent/run';
import { createSnapshotSafe } from '../../agent/snapshot';
import { getAgentDef } from '../../agent/registry';
import { resolveAgentExecutable } from '../../agent/executables';
import { config } from '../../config';
import { resyncChaptersFromDisk } from './chapters';
import { parseChapterNumber, stripChapterMarker } from '../../shared/chapter-names';
import { setChapterStatuses, type ChapterStatus } from '../../shared/chapter-status';
import {
  decodeManuscriptBytes,
  splitManuscript,
  stripBom,
  countManuscriptChars,
  type ManuscriptChapter,
} from '../../shared/manuscript-splitter';
import { extractEpubText, isZipBytes } from '../../shared/epub-text';
import { resolveSkillId } from '../../shared/skill-id';

/**
 * 「导入手稿」路由（挂载于 /api/projects）：
 * - POST /import-manuscript/preview → 上传 txt/md/epub，切章预览，不写任何文件
 * - POST /:id/import-manuscript/commit → 用户确认边界后写入 .novel/chapters/
 *
 * 章节文件名永远由「连续章号」生成（第N章.md），标题只进入正文首行，
 * 绝不参与路径拼接——标题里的 `../` 无法逃逸 chapters 目录。
 */

const manuscriptRouter = new Hono();

/** 项目级未命中锁返回 null，命中返回 409 Response（Hono 处理器必须 return）。 */
function rejectIfRunActive(
  c: { json: (body: Record<string, unknown>, status?: number) => Response },
  projectId: string,
): Response | null {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再导入手稿',
      runId: activeRun.id,
    }, 409);
  }
  return null;
}

/** 标题清洗：去控制字符/换行、折叠空白、限长。标题永远不用于文件名。
 * 上限 180：正文首行还要加「# 第N章 」前缀，而 DB chapters.title 是 varchar(200)。 */
function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    // 标题来自用户上传，控制字符必须剔除，否则会破坏 .md 文件名与 DB 写入。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** 去掉标题里残留的章号标记（章号以导入后的连续文件序号为准）。 */
function normalizeChapterTitle(raw: unknown): string {
  return stripChapterMarker(sanitizeTitle(raw));
}

/** 组装章节文件内容：首行统一为 `# 第N章 标题`，正文前置。 */
function buildChapterFileContent(number: number, rawTitle: unknown, rawContent: string): string {
  let body = stripBom(rawContent).replace(/\r\n?/g, '\n').trim();
  const lines = body.split('\n');
  const title = normalizeChapterTitle(rawTitle);
  // 仅当正文首行确实像「本章标题」时才丢弃，避免误删正文里的 `## 小节`
  if (lines.length > 0) {
    const first = lines[0].trim();
    const firstText = first.replace(/^#{1,6}\s*/, '').trim();
    const isChapterHeading = /^#{1,6}\s/.test(first) && first.length <= 120 && (
      firstText === title
      || new RegExp(`^第\\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\\s*[章回节篇卷]`).test(firstText)
      || /^chapter\s+\d+/i.test(firstText)
    );
    if (isChapterHeading) {
      body = lines.slice(1).join('\n').trim();
    }
  }
  const heading = title ? `# 第${number}章 ${title}` : `# 第${number}章`;
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

interface ParsedUpload {
  text?: string;
  bytes?: Uint8Array;
  filename: string;
  fallbackChunkChars?: number;
}

function parseChunkChars(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 500) return undefined;
  return Math.min(Math.floor(n), 500_000);
}

/** 读取预览请求体：multipart（文件上传）或 JSON（粘贴文本 / base64）。 */
async function readPreviewUpload(c: Context): Promise<ParsedUpload> {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody() as Record<string, string | File>;
    const file = body['file'];
    const fallbackChunkChars = parseChunkChars(body['fallbackChunkChars']);
    if (file && typeof file !== 'string') {
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: typeof file.name === 'string' ? file.name : '',
        fallbackChunkChars,
      };
    }
    const text = body['text'];
    return {
      text: typeof text === 'string' ? text : undefined,
      filename: typeof body['filename'] === 'string' ? body['filename'] : '',
      fallbackChunkChars,
    };
  }

  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const filename = typeof body.filename === 'string' ? body.filename : '';
  const fallbackChunkChars = parseChunkChars(body.fallbackChunkChars);
  if (typeof body.text === 'string') {
    return { text: body.text, filename, fallbackChunkChars };
  }
  if (typeof body.contentBase64 === 'string') {
    return { bytes: new Uint8Array(Buffer.from(body.contentBase64, 'base64')), filename, fallbackChunkChars };
  }
  return { filename, fallbackChunkChars };
}

/**
 * 预览：识别格式 → 解码 → 切章。全程只读，不写磁盘。
 */
manuscriptRouter.post('/import-manuscript/preview', async (c) => {
  let upload: ParsedUpload;
  try {
    upload = await readPreviewUpload(c);
  } catch {
    return c.json({ error: '无法解析上传内容' }, 400);
  }

  const hasFile = upload.bytes !== undefined;
  const hasText = typeof upload.text === 'string';
  if (!hasFile && !hasText) {
    return c.json({ error: '请上传 .txt/.md/.epub 文件，或提供 text 内容' }, 400);
  }

  const filename = upload.filename || '';
  const lowerName = filename.toLowerCase();
  const epubByName = lowerName.endsWith('.epub');
  const unsupportedZipName = ['.docx', '.odt', '.zip', '.azw3', '.mobi'].some((ext) => lowerName.endsWith(ext));
  if (unsupportedZipName) {
    return c.json({ error: '仅支持 .txt / .md / .epub；Word/ODT/其他电子书请先导出为 txt 或 epub' }, 400);
  }
  let format: 'txt' | 'md' | 'epub' = lowerName.endsWith('.md') ? 'md' : 'txt';
  const warnings: string[] = [];
  let text: string;
  let encoding: 'utf-8' | 'gb18030' | 'epub' = 'utf-8';
  let suggestedTitle: string | undefined;

  try {
    if (hasFile) {
      const bytes = upload.bytes!;
      if (bytes.length === 0) return c.json({ error: '文件为空' }, 400);
      const looksZip = isZipBytes(bytes);

      if (epubByName || looksZip) {
        if (!looksZip) {
          return c.json({ error: 'EPUB 文件损坏：不是有效的 ZIP 容器' }, 400);
        }
        const epub = extractEpubText(bytes);
        format = 'epub';
        encoding = 'epub';
        text = epub.text;
        suggestedTitle = epub.title;
        warnings.push(...epub.warnings);
      } else {
        // 常见二进制误传（PDF/图片）：避免被 GB18030 解成乱码后写进项目
        const head = bytes.subarray(0, 8);
        const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
        if (isPdf) {
          return c.json({ error: '不支持 PDF，请先转换为 txt/md/epub' }, 400);
        }
        if (bytes.subarray(0, 8192).includes(0)) {
          return c.json({ error: '仅支持纯文本 .txt/.md 或 .epub 文件' }, 400);
        }
        const decoded = decodeManuscriptBytes(bytes);
        text = decoded.text;
        encoding = decoded.encoding;
        if (decoded.warning) warnings.push(decoded.warning);
      }
    } else {
      text = stripBom(upload.text ?? '');
      if (epubByName) {
        return c.json({ error: 'EPUB 必须以上传文件方式导入' }, 400);
      }
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '书稿解析失败' }, 400);
  }

  if (!text.trim()) {
    return c.json({ error: '未从文件中提取到文本' }, 400);
  }

  try {
    const split = splitManuscript(text, { fallbackChunkChars: upload.fallbackChunkChars });
    return c.json({
      format,
      encoding,
      mode: split.mode,
      warnings: [...warnings, ...split.warnings],
      sourceChars: split.sourceChars,
      chapterCount: split.chapters.length,
      // 独立预览数组（title / charCount / 前 80 字），方便不取正文的调用方
      preview: split.preview,
      chapters: split.chapters.map((ch, i) => ({
        ...ch,
        charCount: split.preview[i]?.charCount ?? 0,
        preview: split.preview[i]?.preview ?? '',
      })),
      suggestedTitle,
    }, 200);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '切章失败' }, 400);
  }
});

interface BackfillResult {
  started: boolean;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  reason?: string;
  message?: string;
}

/**
 * 导入完成后触发「摘要/角色状态补全」——复用现有 enrich 阶段（只增不覆盖），
 * 通过本机 HTTP 调 POST /api/runs，使其成为真正注册的 run（占项目串行锁、
 * 可在会话列表查看、可取消），而不是绕过 run 机制的后台任务。
 */
async function startSummaryBackfill(
  projectId: string,
  projectGenre: string | null,
  preferredAgentId?: string,
): Promise<BackfillResult> {
  try {
    const order = ['claude', 'opencode', 'omp'];
    const candidateIds = preferredAgentId ? [preferredAgentId, ...order] : order;
    let agentId = '';
    for (const id of candidateIds) {
      const def = getAgentDef(id);
      if (def && resolveAgentExecutable(def)) {
        agentId = id;
        break;
      }
    }
    if (!agentId) {
      return { started: false, reason: 'no-agent', message: '本机没有可用的 CLI agent，已跳过自动补全' };
    }

    const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    const hostForUrl = host.includes(':') ? `[${host}]` : host;
    const url = `http://${hostForUrl}:${config.port}/api/runs`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 启用 AUTH_TOKEN 后，这个进程内自调用同样需要凭证（所有 /api/* 都受保护）。
    if (config.auth.token) headers.Authorization = `Bearer ${config.auth.token}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId,
        agentId,
        skillId: resolveSkillId(projectGenre),
        stage: 'enrich',
        message: '手稿已导入。请补全缺失的章节摘要与角色状态（只增不覆盖，已有内容不要修改）。',
        autonomous: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        started: false,
        agentId,
        reason: `http-${res.status}`,
        message: detail.slice(0, 300) || '自动补全启动失败',
      };
    }
    const data = await res.json().catch(() => ({})) as { runId?: string; conversationId?: string };
    return { started: true, agentId, runId: data.runId, conversationId: data.conversationId };
  } catch (err) {
    return {
      started: false,
      reason: 'unreachable',
      message: err instanceof Error ? err.message : '自动补全启动失败',
    };
  }
}

/**
 * 提交导入：写入 .novel/chapters/、落盘章节状态、更新 config/DB、resync、快照。
 */
manuscriptRouter.post('/:id/import-manuscript/commit', async (c) => {
  const projectId = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return c.json({ error: '项目不存在' }, 404);

  // 串行锁：导入会批量覆盖正文章节，run 写入途中执行会互踩
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const rawChapters = body.chapters;
  if (!Array.isArray(rawChapters) || rawChapters.length === 0) {
    return c.json({ error: 'chapters 必填且不能为空' }, 400);
  }
  if (rawChapters.length > 2000) {
    return c.json({ error: '单次最多导入 2000 章，请拆分后重试' }, 400);
  }

  const chapters: Array<{ title: string; content: string }> = [];
  for (let i = 0; i < rawChapters.length; i++) {
    const item = rawChapters[i];
    if (!item || typeof item !== 'object') {
      return c.json({ error: `第 ${i + 1} 章数据格式不正确` }, 400);
    }
    const record = item as Record<string, unknown>;
    const content = typeof record.content === 'string' ? stripBom(record.content).trim() : '';
    if (!content) {
      return c.json({ error: `第 ${i + 1} 章正文为空，请返回预览删除该章或补充内容` }, 400);
    }
    chapters.push({ title: typeof record.title === 'string' ? record.title : '', content });
  }

  const finalized = body.finalized !== false;
  const overwrite = body.overwrite === true;
  const wantBackfill = body.backfill === true;
  const preferredAgentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : undefined;

  // 二次锁检查：JSON 校验期间可能有新 run 启动
  const lockedAgain = rejectIfRunActive(c, projectId);
  if (lockedAgain) return lockedAgain;

  const novelDir = path.join(project.path, '.novel');
  const chaptersDir = path.join(novelDir, 'chapters');
  try {
    await fs.mkdir(chaptersDir, { recursive: true });
  } catch {
    return c.json({ error: '无法创建章节目录，请检查项目路径权限' }, 500);
  }

  // 已有章节检测：默认拒绝覆盖，由前端确认后带 overwrite: true 重试
  const existingNumbers: number[] = [];
  for (let n = 1; n <= chapters.length; n++) {
    const primary = path.join(chaptersDir, `第${n}章.md`);
    const legacy = path.join(chaptersDir, `chapter-${n}.md`);
    if (existsSync(primary) || existsSync(legacy)) existingNumbers.push(n);
  }
  if (existingNumbers.length > 0 && !overwrite) {
    return c.json({
      error: 'chapters-exist',
      message: `项目中已有 ${existingNumbers.length} 章与导入范围重叠（第 ${existingNumbers.slice(0, 10).join('、')}${existingNumbers.length > 10 ? '…' : ''} 章）。确认覆盖这些章节后重试。`,
      existingChapters: existingNumbers,
    }, 409);
  }

  const writtenFiles: string[] = [];
  const removedSummaries: number[] = [];
  const backupFiles: string[] = [];
  try {
    for (let i = 0; i < chapters.length; i++) {
      const number = i + 1;
      const filePath = path.join(chaptersDir, `第${number}章.md`);
      const legacyPath = path.join(chaptersDir, `chapter-${number}.md`);
      const content = buildChapterFileContent(number, chapters[i].title, chapters[i].content);

      // 覆盖前备份原文件（仅 .bak 一份，与 import-source 行为一致）
      for (const candidate of [filePath, legacyPath]) {
        if (!existsSync(candidate)) continue;
        const backup = `${candidate}.bak`;
        await fs.copyFile(candidate, backup);
        backupFiles.push(backup);
      }

      // 先写临时文件再 rename：中断不会留下半截章节
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${number}`;
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, filePath);
      const legacyBackup = existsSync(legacyPath) ? legacyPath : null;
      if (legacyBackup) {
        // 旧英文命名已迁移到第N章.md，删除旧文件避免 resync 看到重复章节号
        await fs.unlink(legacyBackup).catch(() => {});
      }
      writtenFiles.push(path.basename(filePath));

      if (overwrite) {
        // 正文被替换后旧摘要必然失真；删除以便 backfill 重新生成
        const summaryPath = path.join(chaptersDir, `第${number}章.summary.md`);
        try {
          await fs.unlink(summaryPath);
          removedSummaries.push(number);
        } catch { /* 无摘要 */ }
      }
    }
  } catch (err) {
    return c.json({
      error: '写入章节失败',
      message: err instanceof Error ? err.message : String(err),
      written: writtenFiles.length,
    }, 500);
  }

  // 章节状态落盘（事实源）：默认 finalized；正文过短的章不冒充「已定稿」
  const statusEntries = new Map<number, ChapterStatus>();
  const shortChapters: number[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const number = i + 1;
    const wordCount = countManuscriptChars(chapters[i].content);
    if (finalized && wordCount < 100) {
      statusEntries.set(number, 'draft');
      shortChapters.push(number);
    } else {
      statusEntries.set(number, finalized ? 'finalized' : 'draft');
    }
  }
  await setChapterStatuses(novelDir, statusEntries);

  // 磁盘上超出本次导入范围的章节保留，仅提示（不做破坏性删除）
  let maxExistingNumber = chapters.length;
  try {
    for (const file of await fs.readdir(chaptersDir)) {
      const n = parseChapterNumber(file);
      if (n !== null) maxExistingNumber = Math.max(maxExistingNumber, n);
    }
  } catch { /* chapters 目录刚建，忽略 */ }
  const extraChapters = maxExistingNumber > chapters.length;

  // config.json：备份后更新章数/目标字数，并标记来源已导入（复盘门豁免）
  let newTargetWords = project.targetWords;
  const newChapterCount = Math.max(chapters.length, maxExistingNumber);
  const oldPerChapter = project.targetWords > 0 && project.chapterCount > 0
    ? project.targetWords / project.chapterCount
    : 0;
  // 夹在 int32 内：异常高章号（如残留 第99999章.md）不应让目标字数溢出 DB 列
  if (oldPerChapter > 0) newTargetWords = Math.min(2_000_000_000, Math.round(oldPerChapter * newChapterCount));

  const configPath = path.join(novelDir, 'config.json');
  let novelConfig: Record<string, unknown> = {};
  try {
    novelConfig = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    await fs.copyFile(configPath, `${configPath}.bak`);
  } catch { /* 无配置或解析失败，按空对象处理 */ }
  novelConfig = {
    ...novelConfig,
    chapterCount: newChapterCount,
    targetWords: newTargetWords,
    sourceImported: true,
    manuscriptImportedAt: new Date().toISOString(),
  };
  const configTmp = `${configPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(configTmp, JSON.stringify(novelConfig, null, 2), 'utf-8');
  await fs.rename(configTmp, configPath);

  // 定稿导入后按章节数推进阶段（只前进不回退）：≥3 章→writing，1-2 章→sample。
  // 手稿已是成品，让用户从 concept 重新走一遍流程没有意义。
  const STAGE_ORDER = ['concept', 'world', 'characters', 'outline', 'scenes', 'sample', 'writing'];
  const finalizedCount = [...statusEntries.values()].filter((s) => s === 'finalized').length;
  let nextStage: string | undefined;
  if (finalizedCount > 0) {
    const targetStage = finalizedCount >= 3 ? 'writing' : 'sample';
    const currentIndex = STAGE_ORDER.indexOf(project.currentStage);
    if (currentIndex >= 0 && currentIndex < STAGE_ORDER.indexOf(targetStage)) nextStage = targetStage;
  }

  // DB 缓存对齐：章数与目标字数（每章目标语义不变）
  await db.update(projects)
    .set({
      chapterCount: newChapterCount,
      targetWords: newTargetWords,
      updatedAt: new Date(),
      ...(nextStage ? { currentStage: nextStage } : {}),
    })
    .where(eq(projects.id, projectId));

  // 磁盘为事实源：立即重建 chapters 表（status 从 chapter-status.json 回填）
  let resyncFailed = false;
  try {
    await resyncChaptersFromDisk(projectId, { force: true });
  } catch {
    resyncFailed = true;
  }

  // git 快照：走进程级互斥，避免与审阅/回滚的 checkout 交错
  const snapshot = await createSnapshotSafe(
    project.path,
    `import manuscript: ${chapters.length} chapters`,
  ).catch(() => ({ hash: null, skipped: true, failed: false }));

  const warnings: string[] = [];
  if (shortChapters.length > 0) {
    warnings.push(`第 ${shortChapters.join('、')} 章正文不足 100 字，已标记为草稿（未冒充定稿）`);
  }
  if (extraChapters) {
    const extraLabel = maxExistingNumber === chapters.length + 1
      ? `第 ${maxExistingNumber} 章`
      : `第 ${chapters.length + 1}–${maxExistingNumber} 章`;
    warnings.push(`磁盘上还有超出导入范围的章节（${extraLabel}），已原样保留`);
  }
  if (resyncFailed) {
    warnings.push('章节表缓存同步失败，打开项目时会自动重试（磁盘章节文件已写入）');
  }
  if (snapshot.skipped) {
    warnings.push('本次未立即创建 git 快照（可能有审阅/回滚操作在途，下一次 run 结束时会自动捕获）');
  }
  if (snapshot.failed) {
    warnings.push('git 快照创建失败（章节已写入；请检查项目的 git 状态，下一次 run 结束时会再次尝试）');
  }

  // 摘要/角色状态补全：显式请求时启动真正的 enrich run（不阻塞导入响应）
  const backfill = wantBackfill
    ? await startSummaryBackfill(projectId, project.genre, preferredAgentId)
    : undefined;

  return c.json({
    imported: chapters.length,
    chapterNumbers: chapters.map((_, i) => i + 1),
    finalized,
    statusCounts: {
      finalized: [...statusEntries.values()].filter((s) => s === 'finalized').length,
      draft: [...statusEntries.values()].filter((s) => s === 'draft').length,
    },
    overwritten: existingNumbers.length,
    backups: backupFiles.length,
    removedSummaries: removedSummaries.length,
    warnings,
    snapshot,
    backfill,
  }, 201);
});

export default manuscriptRouter;

/** 导出给测试/其它模块复用的纯函数（保持实现单一来源）。 */
export { buildChapterFileContent, normalizeChapterTitle, sanitizeTitle };

/** 供类型检查：预览响应里的章节结构（前端可用）。 */
export type ManuscriptPreviewChapter = ManuscriptChapter & { charCount: number; preview: string };
