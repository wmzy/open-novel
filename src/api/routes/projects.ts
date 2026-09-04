import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { eq, desc } from 'drizzle-orm';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, copyFileSync, statSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../db/drizzle';
import { projects, conversations } from '../../db/schema';
import { generateId } from '../../utils/id';
import { getPlugin } from '../../plugins/registry';
import { resolveSkillId } from '../../shared/skill-id';
import { subscribe } from '../../agent/file-watcher';
import { subscribeProjectEvents, emitProjectEvent } from '../../agent/project-events';
import { resolveProjectDir, resolveNovelDir } from '../../shared/project-dir';
import { getActiveRunForProject } from '../../agent/run';
import { buildIntentSkeleton, type IntentInput } from '../../shared/intent-card';
import { detectChapters, type ChunkSource } from '../../shared/text-chunker';
import { gitSync, ensureDraftBranch } from '../../agent/snapshot';
import {
  TEMPLATE_GENERATORS,
  TEMPLATE_FILE_PATHS,
  generateOutlineDetailedSplit,
  type TemplateGenOptions,
} from '../../shared/template-generator';
import { splitMarkdownToCards, buildIndexMarkdown, DOC_DIR } from '../../shared/split-document';
import type { DocType } from '../../shared/split-document';
import { STAGES } from '../../shared/stages';
import timelineRouter from './timeline';
import documentsRouter from './documents';
import { resyncChaptersFromDisk } from './chapters';

const projectsRouter = new Hono();

// 故事脉络子路由（/:id/timeline 等）
projectsRouter.route('/', timelineRouter);
projectsRouter.route('/', documentsRouter);

/** 目录下已存在 open-novel 项目结构时拒绝（两条记录指向同一目录会互相污染）。 */
function canonicalProjectPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // 目录尚未创建/已失效：回退到词法解析
    return path.resolve(p);
  }
}

/** 按真实路径（symlink 归一化）查重：同一磁盘目录只允许一条项目记录。
 * 双记录会让项目级串行锁失效——两个 run 可并行写同一目录。 */
async function findProjectByCanonicalPath(canon: string) {
  const all = await db.select().from(projects);
  for (const p of all) {
    if (canonicalProjectPath(p.path) === canon) return p;
  }
  return null;
}

projectsRouter.get('/', async (c) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt));
  const enriched = all.map((p) => ({
    ...p,
    pathExists: existsSync(p.path),
  }));
  return c.json({ projects: enriched });
});

projectsRouter.post('/', async (c) => {
  const body = await c.req.json();
  if (!body.path || typeof body.path !== 'string') {
    return c.json({ error: 'path is required' }, 400);
  }
  const id = generateId('proj_');
  const userPath = path.resolve(body.path);
  // Prevent creating directories in sensitive system locations
  const sensitive = ['/etc', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib'];
  if (sensitive.some((p) => userPath === p || userPath.startsWith(p + '/'))) {
    return c.json({ error: '不允许在系统目录下创建项目' }, 400);
  }
  // 目录已是 open-novel 项目（存在 .novel/）：引导用户走「打开项目」，
  // 避免两条项目记录指向同一目录（删除其中一个会互相污染）。
  if (existsSync(path.join(userPath, '.novel'))) {
    return c.json({
      error: 'workspace-exists',
      message: '该目录已是 open-novel 项目（存在 .novel/ 结构），请使用「打开项目」导入',
    }, 409);
  }
  // 非空目录警告：目录中已有 .novel 之外的文件时，git 快照会把它们卷入版本库，
  // 且「删除项目-同时删除文件」只允许删除纯 open-novel 目录——提前告知而非事后踩坑。
  let warning: string | undefined;
  if (existsSync(userPath)) {
    try {
      const entries = readdirSync(userPath);
      if (entries.length > 0) {
        warning = `该目录已有 ${entries.length} 个文件（如 ${entries.slice(0, 3).join('、')}${entries.length > 3 ? '…' : ''}）。现有文件会被纳入项目版本管理；删除项目时仅允许删除纯 open-novel 目录。`;
      }
    } catch { /* 读取失败不阻断创建 */ }
  }
  mkdirSync(userPath, { recursive: true });
  // 真实路径查重：symlink/相对路径等不同写法指向同一目录时拒绝第二条记录
  const canonical = canonicalProjectPath(userPath);
  const dup = await findProjectByCanonicalPath(canonical);
  if (dup) {
    return c.json({
      error: 'path-exists',
      message: `该目录已是 open-novel 项目「${dup.title}」（可能经其他路径形式创建）。请使用「打开项目」导入，或另选目录。`,
    }, 409);
  }
  const [project] = await db.insert(projects).values({
    id,
    title: body.title || '未命名项目',
    path: userPath,
    genre: body.genre || 'general',
    targetWords: body.targetWords || 100000,
    chapterCount: body.chapterCount || 20,
    theme: body.theme || null,
    perspective: body.perspective || 'third-person',
  }).returning();

  // 过滤空意图字段：全部为空时按未提供处理（不生成 intent.md）
  const rawIntent = (body.intent ?? {}) as Record<string, unknown>;
  const intentEntries = Object.entries(rawIntent).filter(
    ([, value]) => typeof value === 'string' && value.trim(),
  ) as Array<[keyof IntentInput, string]>;
  const intent: IntentInput | undefined = intentEntries.length > 0
    ? Object.fromEntries(intentEntries) as IntentInput
    : undefined;

  // Auto-initialize workspace
  initWorkspace(userPath, {
    title: project.title,
    genre: project.genre,
    targetWords: project.targetWords,
    chapterCount: project.chapterCount,
    perspective: project.perspective,
    skillId: body.skillId,
    intent,
  });

  return c.json({ project, warning }, 201);
});

/**
 * 按磁盘内容推断导入项目的当前阶段。
 * 存量项目导入后进度条停在「概念」会让首条写作消息触发阶段错配提示——
 * 这里按产出文件反推：≥3 章正文→writing；有正文→sample；有场景表→sample；
 * 有大纲→scenes；有角色档案→outline；有世界观→characters；有概念→world。
 */
function inferStageFromDisk(novelDir: string): string {
  const chaptersDir = path.join(novelDir, 'chapters');
  let writtenCount = 0;
  try {
    for (const f of readdirSync(chaptersDir)) {
      const m = f.match(/^第(\d+)章\.md$/) || f.match(/^chapter-(\d+)\.md$/i);
      if (!m) continue;
      try {
        const content = readFileSync(path.join(chaptersDir, f), 'utf-8');
        const stripped = content.replace(/^[#*>\-[\]()!|]+\s*/gm, '').trim();
        const cjk = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
        if (cjk >= 100) writtenCount++;
      } catch { /* skip unreadable */ }
    }
  } catch { /* no chapters dir */ }
  if (writtenCount >= 3) return 'writing';
  if (writtenCount >= 1) return 'sample';
  if (existsSync(path.join(novelDir, 'scenes.md'))) return 'sample';
  if (existsSync(path.join(novelDir, 'outline')) || existsSync(path.join(novelDir, 'outline-detailed.md'))) return 'scenes';
  if (existsSync(path.join(novelDir, 'characters'))) return 'outline';
  if (existsSync(path.join(novelDir, 'world')) || existsSync(path.join(novelDir, 'world-building.md'))) return 'characters';
  if (existsSync(path.join(novelDir, 'concept')) || existsSync(path.join(novelDir, 'concept.md'))) return 'world';
  return 'concept';
}

// Import an existing .novel/ directory
projectsRouter.post('/import', async (c) => {
  const body = await c.req.json();
  const userPath = path.resolve(body.path);
  const novelDir = path.join(userPath, '.novel');

  if (!existsSync(novelDir)) {
    return c.json({ error: '该目录下不存在 .novel/ 结构' }, 400);
  }

  // Read config.json if it exists
  let title = body.title || path.basename(userPath);
  let genre = 'general';
  let targetWords = 100000;
  let chapterCount = 20;
  let perspective = 'third-person';

  const configPath = path.join(novelDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      title = config.title || title;
      genre = config.genre || genre;
      targetWords = config.targetWords || targetWords;
      chapterCount = config.chapterCount || chapterCount;
      perspective = config.perspective || perspective;
    } catch { /* ignore */ }
  }

  // Check if already imported（真实路径查重，防 symlink/写法差异双记录）
  const canonical = canonicalProjectPath(userPath);
  const existing = await findProjectByCanonicalPath(canonical);
  if (existing) {
    return c.json({ error: '该项目已导入', message: `该目录已存在项目「${existing.title}」` }, 400);
  }

  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title,
    path: userPath,
    genre,
    targetWords,
    chapterCount,
    perspective,
    // 按磁盘产出反推阶段，避免存量项目导入后停在「概念」触发阶段错配提示
    currentStage: inferStageFromDisk(novelDir),
  }).returning();

  return c.json({ project }, 201);
});

// Import source text into an existing project: chunk + write standardized chapters.
// 逆向拆书的文件准备阶段；agent 拆解由 /api/runs (stage=decompose) 驱动。
projectsRouter.post('/:id/import-source', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: '项目不存在' }, 404);

  // 项目串行锁：导入会覆盖正文章节文件，run 写入途中执行会互踩
  const activeRun = getActiveRunForProject(id);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再导入',
      runId: activeRun.id,
    }, 409);
  }

  const body = await c.req.json();
  const sourcePath = path.resolve(body.sourcePath);

  if (!existsSync(sourcePath)) {
    return c.json({ error: '源路径不存在' }, 400);
  }

  const projectDir = project.path;
  const novelDir = path.join(projectDir, '.novel');

  // 收集源文本
  const stat = statSync(sourcePath);
  const source: ChunkSource = stat.isDirectory()
    ? { kind: 'dir', files: collectTextFiles(sourcePath) }
    : { kind: 'file', content: readFileSync(sourcePath, 'utf-8'), filename: path.basename(sourcePath) };

  if (source.kind === 'dir' && source.files.length === 0) {
    return c.json({ error: '未找到 .txt 或 .md 文件' }, 400);
  }

  // 切章
  const chapters = detectChapters(source);
  if (chapters.length === 0) {
    return c.json({ error: '未检测到有效文本' }, 400);
  }

  // 写标准化章节文件（与已有章节冲突时先备份为 .bak，再覆盖）
  mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });
  const conflicts: number[] = [];
  for (const ch of chapters) {
    const header = ch.title && ch.title !== `第${ch.number}章`
      ? `# 第${ch.number}章 ${ch.title}`
      : `# 第${ch.number}章`;
    const chapterPath = path.join(novelDir, 'chapters', `第${ch.number}章.md`);
    if (existsSync(chapterPath)) {
      copyFileSync(chapterPath, `${chapterPath}.bak`);
      conflicts.push(ch.number);
    }
    writeFileSync(chapterPath, `${header}\n\n${ch.content}`);
  }

  // 更新 config.json（覆盖前备份）
  const configPath = path.join(novelDir, 'config.json');
  if (existsSync(configPath)) {
    copyFileSync(configPath, `${configPath}.bak`);
  }
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch { /* noop */ }
  config.chapterCount = chapters.length;
  // 逆向拆书项目标记：样章门禁的复盘要求对导入源文本豁免（导入原文无样章复盘概念）
  config.sourceImported = true;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // 更新 DB：章节数变化会摊薄每章字数目标（targetWords/chapterCount）。
  // 保持「每章目标」语义不变：按新旧章数比例重算目标字数，避免后续写作
  // run 的每章目标被导入章数稀释（如 20 章/8 万字导入 100 章后每章只剩 800 字）。
  const oldPerChapter = project.targetWords > 0 && project.chapterCount > 0
    ? project.targetWords / project.chapterCount
    : 0;
  const newTargetWords = oldPerChapter > 0
    ? Math.round(oldPerChapter * chapters.length)
    : project.targetWords;
  await db.update(projects)
    .set({ chapterCount: chapters.length, targetWords: newTargetWords })
    .where(eq(projects.id, id));

  // 同步 chapters 表：导入的章节立即可见于写作视图与样章门（磁盘为事实源）
  await resyncChaptersFromDisk(id, { force: true }).catch(() => {});

  return c.json({ chapterCount: chapters.length, conflicts }, 200);
});

/** 收集目录下所有 .txt/.md 文件的 { name, content }。 */
function collectTextFiles(dir: string): { name: string; content: string }[] {
  return readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((f) => ({ name: f, content: readFileSync(path.join(dir, f), 'utf-8') }));
}

projectsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);
  // 迁移到双分支模型（幂等，已有 draft 则跳过）。失败不阻塞项目读取。
  await ensureDraftBranch(project.path).catch(() => {});
  // 读取磁盘 config.json 附带样章门旁路标记（force 旁路时落盘，Dashboard 常驻警示）
  let sampleGateBypassed = false;
  try {
    const cfg = JSON.parse(readFileSync(path.join(project.path, '.novel', 'config.json'), 'utf-8'));
    sampleGateBypassed = cfg.sampleGateBypassed === true;
  } catch { /* 无配置文件 */ }
  return c.json({ project: { ...project, skillId: resolveSkillId(project.genre), sampleGateBypassed } });
});

projectsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  // Whitelist allowed fields to prevent mass assignment
  const allowed: Record<string, unknown> = {};
  if (body.title !== undefined) allowed.title = body.title;
  if (body.genre !== undefined) allowed.genre = body.genre;
  if (body.targetWords !== undefined) allowed.targetWords = body.targetWords;
  if (body.chapterCount !== undefined) allowed.chapterCount = body.chapterCount;
  if (body.theme !== undefined) allowed.theme = body.theme;
  if (body.perspective !== undefined) allowed.perspective = body.perspective;
  if (body.currentStage !== undefined) {
    // 枚举校验：只接受 7 个主阶段之一，防止 agent/前端写入非法阶段值
    const valid = STAGES.map((s) => s.id);
    if (typeof body.currentStage !== 'string' || !valid.includes(body.currentStage)) {
      return c.json({ error: `currentStage 必须是 ${valid.join('/')} 之一` }, 400);
    }
    allowed.currentStage = body.currentStage;
  }
  allowed.updatedAt = new Date();

  const [updated] = await db.update(projects)
    .set(allowed)
    .where(eq(projects.id, id))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);

  // Emit project update event
  emitProjectEvent(id, 'project-updated', { project: updated });

  return c.json({ project: updated });
});

projectsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  // 项目串行锁：run 存活时删除项目会让 close handler 写库报错、目录被 rm 后 agent 写入孤儿文件
  const activeRun = getActiveRunForProject(id);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先停止任务后再删除项目',
      runId: activeRun.id,
    }, 409);
  }

  // removeFiles=true：连同磁盘上的小说目录一起删除（用户显式确认的不可恢复操作）。
  // 默认仅移出列表——文件保留在磁盘，避免「以为删了数据」的隐私/清理预期落空。
  const removeFiles = c.req.query('removeFiles') === 'true';
  if (removeFiles) {
    const userPath = path.resolve(project.path);
    const sensitive = ['/etc', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib'];
    if (sensitive.some((p) => userPath === p || userPath.startsWith(p + '/'))) {
      return c.json({ error: '拒绝删除系统目录下的项目文件' }, 400);
    }
    // 目录内容白名单：只允许删除 open-novel 自身的产物（.novel/、.git/、.gitignore）。
    // 用户若把项目建在已有个人文件的目录里，rm -rf 会连坐删除——此处直接拒绝。
    const ALLOWED_PROJECT_ENTRIES = new Set(['.novel', '.git', '.gitignore']);
    try {
      const entries = readdirSync(userPath);
      const foreign = entries.filter((e) => !ALLOWED_PROJECT_ENTRIES.has(e));
      if (foreign.length > 0) {
        return c.json({
          error: 'dir-not-exclusive',
          message: `目录包含非 open-novel 内容（${foreign.slice(0, 5).join('、')}${foreign.length > 5 ? ' 等' : ''}），为避免误删已拒绝删除。请先手动移出这些文件，或改用「仅移出列表」。`,
          foreign,
        }, 409);
      }
    } catch {
      return c.json({ error: '磁盘文件删除失败，项目记录未移除' }, 500);
    }
    try {
      rmSync(userPath, { recursive: true, force: true });
    } catch {
      return c.json({ error: '磁盘文件删除失败，项目记录未移除' }, 500);
    }
  }

  await db.delete(projects).where(eq(projects.id, id));
  return c.json({ ok: true, removedFiles: removeFiles });
});

projectsRouter.post('/:id/init', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  initWorkspace(project.path, {
    title: project.title,
    genre: project.genre,
    targetWords: project.targetWords,
    chapterCount: project.chapterCount,
    perspective: project.perspective,
    skillId: body.skillId,
  });

  return c.json({ ok: true });
});

// Sync project with remote git
projectsRouter.post('/:id/sync', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveProjectDir(projectId);

  // 项目串行锁：run 写入途中 pull --rebase 会覆盖工作区
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再同步',
      runId: activeRun.id,
    }, 409);
  }

  const result = await gitSync(projectDir);
  if (!result.success) return c.json({ error: result.message }, 400);
  return c.json({ ok: true, message: result.message });
});

function copyTemplates(src: string, dest: string, vars: Record<string, string>) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTemplates(srcPath, destPath, vars);
    } else {
      let content = readFileSync(srcPath, 'utf-8');
      for (const [key, value] of Object.entries(vars)) {
        content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }
      writeFileSync(destPath, content);
    }
  }
}

interface WorkspaceOpts {
  title: string;
  genre: string;
  targetWords: number;
  chapterCount: number;
  perspective: string;
  skillId?: string;
  /** 新建项目表单采集的创作偏好（可选）。 */
  intent?: IntentInput;
}

/**
 * Initialize .novel/ workspace in the given directory.
 * Skips if .novel/ already exists.
 */
function initWorkspace(projectDir: string, opts: WorkspaceOpts): void {
  const plugin = getPlugin(opts.skillId || opts.genre || 'novel') || getPlugin('novel');
  if (!plugin) return;

  const novelDir = path.join(projectDir, '.novel');
  if (existsSync(novelDir)) return;

  mkdirSync(novelDir, { recursive: true });
  mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
  mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

  // 初始化文风参考目录：创建 .novel/styles/ 并拷贝 README.md 说明文件。
  const stylesDir = path.join(novelDir, 'styles');
  mkdirSync(stylesDir, { recursive: true });
  const stylesReadme = path.join(stylesDir, 'README.md');
  if (!existsSync(stylesReadme)) {
    const stylesReadmeTemplate = path.resolve(process.cwd(), 'templates', 'styles', 'README.md');
    if (existsSync(stylesReadmeTemplate)) {
      copyFileSync(stylesReadmeTemplate, stylesReadme);
    }
  }

  // 初始化创作者约束层：若 .novel/CREATOR.md 不存在，从项目根 templates/ 拷贝默认内容。
  const creatorPath = path.join(novelDir, 'CREATOR.md');
  if (!existsSync(creatorPath)) {
    const creatorTemplate = path.resolve(process.cwd(), 'templates', 'CREATOR.md');
    if (existsSync(creatorTemplate)) {
      copyFileSync(creatorTemplate, creatorPath);
    }
  }

  // 初始化状态分离文件：progress.md 与 character-states.md（若不存在则从 templates/ 拷贝）。
  for (const tmplName of ['progress.md', 'character-states.md']) {
    const dest = path.join(novelDir, tmplName);
    if (!existsSync(dest)) {
      const tmpl = path.resolve(process.cwd(), 'templates', tmplName);
      if (existsSync(tmpl)) {
        copyFileSync(tmpl, dest);
      }
    }
  }

  const templatesDir = path.join(plugin.path, 'templates');
  if (existsSync(templatesDir)) {
    copyTemplates(templatesDir, novelDir, {
      title: opts.title,
      genre: opts.genre,
      targetWords: String(opts.targetWords),
      chapterCount: String(opts.chapterCount),
    });
  }

  // 意图卡：表单提供的创作偏好写入 intent.md（存量项目 .novel 已存在时函数已提前 return，不受影响）
  if (opts.intent) {
    writeFileSync(path.join(novelDir, 'intent.md'), buildIntentSkeleton(opts.intent), 'utf-8');
  }

  writeFileSync(path.join(novelDir, 'config.json'), JSON.stringify({
    title: opts.title,
    genre: opts.genre,
    targetWords: opts.targetWords,
    chapterCount: opts.chapterCount,
    perspective: opts.perspective,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

// List conversations for a project
projectsRouter.get('/:id/conversations', async (c) => {
  const projectId = c.req.param('id');
  const convs = await db.select().from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt));
  return c.json({ conversations: convs });
});

// Upload a file to the project
projectsRouter.post('/:id/upload', async (c) => {
  const projectId = c.req.param('id');

  // 项目串行锁：上传会写文件，与 agent 写盘互踩
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再上传',
      runId: activeRun.id,
    }, 409);
  }

  const projectDir = await resolveNovelDir(projectId);

  const body = await c.req.parseBody();
  const file = body['file'];
  const targetPath = body['path'] as string;

  if (!file || typeof file === 'string') {
    return c.json({ error: 'No file provided' }, 400);
  }

  if (!targetPath) {
    return c.json({ error: 'Target path is required' }, 400);
  }

  // Normalize and validate path
  const normalizedPath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const dir = path.dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, buffer);
    return c.json({ ok: true, path: normalizedPath });
  } catch {
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// Read file content from project
projectsRouter.get('/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'path is required' }, 400);

  // Normalize and resolve path
  const projectDir = await resolveNovelDir(projectId);
  // 去掉前导 .novel/（agent 文本里常用 .novel/xxx.md 引用文件，
  // 但 API 从 .novel 目录解析相对路径）
  const cleanedPath = filePath.replace(/^(\.\/|\/+)/, '').replace(/^\.novel\//, '');
  const normalizedPath = path.normalize(cleanedPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  // Security: ensure path is within project directory (prevent path traversal)
  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    return c.json({ path: normalizedPath, content });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// Write file content to project (.novel 目录下)
projectsRouter.put('/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const body = await c.req.json();
  const filePath = body.path as string;
  const content = body.content as string;
  if (!filePath || typeof content !== 'string') {
    return c.json({ error: 'path and content are required' }, 400);
  }

  // 项目串行锁：run 正在写设定/章节文件时，前端手写会与 agent 写盘互踩
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再保存文件',
      runId: activeRun.id,
    }, 409);
  }

  const projectDir = await resolveNovelDir(projectId);
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  // Security: ensure path is within project directory (prevent path traversal)
  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    return c.json({ ok: true, path: normalizedPath });
  } catch {
    return c.json({ error: 'Write failed' }, 500);
  }
});

// List files in project directory
projectsRouter.get('/:id/files/list', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);

  try {
    const files = listFilesRecursive(projectDir, '');
    return c.json({ files });
  } catch {
    return c.json({ files: [] });
  }
});

function listFilesRecursive(dir: string, prefix: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(path.join(dir, entry.name), relPath));
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
        results.push(relPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}

// SSE endpoint for real-time file change and project update notifications
projectsRouter.get('/:id/events', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    // Subscribe to file changes
    const unsubscribeFiles = subscribe(projectDir, (event) => {
      streamWriter.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Subscribe to project updates
    const unsubscribeProject = subscribeProjectEvents(projectId, (event) => {
      streamWriter.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Keep-alive heartbeat
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      unsubscribeFiles();
      unsubscribeProject();
    });

    // Keep stream open until client disconnects
    await new Promise<void>((resolve) => {
      streamWriter.onAbort(() => resolve());
    });
  });
});

/**
 * 从 project 行构造模板生成所需的元数据。
 * theme 在 schema 中可空，这里转为可选字段。
 */
function toTemplateOptions(p: typeof projects.$inferSelect): TemplateGenOptions {
  return {
    chapterCount: p.chapterCount,
    targetWords: p.targetWords,
    title: p.title,
    genre: p.genre,
    perspective: p.perspective,
    theme: p.theme ?? undefined,
  };
}

// 按项目元数据动态生成模板脚手架并写入 .novel/ 目录；已存在文件备份为 .bak
projectsRouter.post('/:id/generate-templates', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  // 项目串行锁：生成模板会覆盖/备份 .novel 下文件
  const activeRun = getActiveRunForProject(id);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再生成模板',
      runId: activeRun.id,
    }, 409);
  }

  const novelDir = path.join(project.path, '.novel');
  mkdirSync(novelDir, { recursive: true });

  // 可选：请求体传入 { templates: [...] } 限定生成范围；默认生成全部
  let requested = Object.keys(TEMPLATE_FILE_PATHS);
  try {
    const body = await c.req.json();
    if (Array.isArray(body.templates) && body.templates.length > 0) {
      requested = body.templates;
    }
  } catch { /* 无请求体或非 JSON，使用默认全集 */ }

  const opts = toTemplateOptions(project);
  const written: { name: string; path: string; backedUp: boolean }[] = [];

  for (const name of requested) {
    const generator = TEMPLATE_GENERATORS[name];
    const relPath = TEMPLATE_FILE_PATHS[name];
    if (!generator || !relPath) continue; // 跳过未知模板名

    // outline-detailed 特殊处理：拆分型模板（目录 + 逐章卡片）
    if (name === 'outline-detailed') {
      const split = generateOutlineDetailedSplit(opts);
      const outlineDir = path.join(novelDir, 'outline');
      mkdirSync(path.join(outlineDir, 'chapters'), { recursive: true });
      const backedUp = existsSync(path.join(novelDir, 'outline-detailed.md'));
      if (backedUp) {
        copyFileSync(path.join(novelDir, 'outline-detailed.md'), path.join(novelDir, 'outline-detailed.md.bak'));
      }
      writeFileSync(path.join(outlineDir, 'index.md'), split.indexContent, 'utf-8');
      for (const card of split.cards) {
        writeFileSync(path.join(outlineDir, card.relativePath), card.content, 'utf-8');
      }
      written.push({ name, path: 'outline/', backedUp });
      continue;
    }

    const fullPath = path.join(novelDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    // 已存在则备份（覆盖旧 .bak），再加 .bak 后缀
    const backedUp = existsSync(fullPath);
    if (backedUp) copyFileSync(fullPath, `${fullPath}.bak`);
    writeFileSync(fullPath, generator(opts), 'utf-8');
    written.push({ name, path: relPath, backedUp });
  }

  return c.json({ ok: true, written });
});

// 预览（不写文件）：返回指定模板的生成内容
projectsRouter.get('/:id/templates/:templateName', async (c) => {
  const id = c.req.param('id');
  const templateName = c.req.param('templateName');
  const generator = TEMPLATE_GENERATORS[templateName];
  if (!generator) {
    return c.json({ error: `未知模板：${templateName}` }, 400);
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const content = generator(toTemplateOptions(project));
  return c.json({
    name: templateName,
    path: TEMPLATE_FILE_PATHS[templateName],
    content,
  });
});

/**
 * 迁移：将旧格式单文件（concept.md / world-building.md / outline-detailed.md）
 * 拆分为目录 + 索引 + 卡片文件。新项目无需调用。
 * 幂等：目录已存在且有 index.md 时跳过该文档。
 */
projectsRouter.post('/:id/migrate-split', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  // 项目串行锁：迁移写卡片 + 删旧文件，与 agent 写盘互斥
  const activeRun = getActiveRunForProject(id);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再迁移文档结构',
      runId: activeRun.id,
    }, 409);
  }

  const novelDir = path.join(project.path, '.novel');

  const migrations: Array<{ oldFile: string; docType: DocType }> = [
    { oldFile: 'concept.md', docType: 'concept' },
    { oldFile: 'world-building.md', docType: 'world' },
    { oldFile: 'outline-detailed.md', docType: 'outline' },
  ];

  // outline 三幕分界从 outline-meta.json 读取
  let actBreaks: [number, number] | undefined;
  try {
    const metaRaw = readFileSync(path.join(novelDir, 'outline-meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw);
    if (Array.isArray(meta.actBreaks) && meta.actBreaks.length >= 2) {
      actBreaks = [meta.actBreaks[0], meta.actBreaks[1]];
    }
  } catch { /* no meta file */ }

  const results: Array<{ docType: string; cards: number; migrated: boolean; skipped: boolean }> = [];

  for (const migration of migrations) {
    const oldPath = path.join(novelDir, migration.oldFile);
    const newDir = path.join(novelDir, DOC_DIR[migration.docType]);

    // 幂等：目录已有 index.md 则跳过
    if (existsSync(path.join(newDir, 'index.md'))) {
      results.push({ docType: migration.docType, cards: 0, migrated: false, skipped: true });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(oldPath, 'utf-8');
    } catch {
      results.push({ docType: migration.docType, cards: 0, migrated: false, skipped: false });
      continue;
    }

    const split = splitMarkdownToCards(content, migration.docType);
    const finalActBreaks = migration.docType === 'outline' ? actBreaks : undefined;
    const indexContent = buildIndexMarkdown(
      migration.docType,
      `《${project.title}》`,
      split.cards,
      finalActBreaks,
      migration.docType === 'outline' ? project.chapterCount ?? undefined : undefined,
    );

    mkdirSync(newDir, { recursive: true });
    writeFileSync(path.join(newDir, 'index.md'), indexContent, 'utf-8');

    for (const card of split.cards) {
      const cardPath = path.join(newDir, card.fileName);
      mkdirSync(path.dirname(cardPath), { recursive: true });
      writeFileSync(cardPath, card.content, 'utf-8');
    }

    // 删旧文件
    try { unlinkSync(oldPath); } catch { /* already gone */ }

    results.push({ docType: migration.docType, cards: split.cards.length, migrated: true, skipped: false });
  }

  return c.json({ ok: true, results });
});

export default projectsRouter;
