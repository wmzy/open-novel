/**
 * 拆分文档合并读取接口。
 *
 * GET /:id/document/:type — 读取目录（index.md + 全部卡片），按顺序拼合为单个 markdown。
 * 前端视图用 parseSections 渲染，输入需要合并后的整份 markdown。
 */

import { Hono } from 'hono';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveNovelDir } from '../../shared/project-dir';
import { regenerateOutlineIndex } from '../../shared/outline-meta';
import type { DocType } from '../../shared/split-document';

const documentsRouter = new Hono();

const VALID_TYPES = new Set<DocType>(['concept', 'world', 'outline']);

/** DocType → .novel/ 下的目录名。 */
const DIR_MAP: Record<DocType, string> = {
  concept: 'concept',
  world: 'world',
  outline: 'outline',
};

/** DocType → 旧格式单文件名（拆分前的 .novel/ 根文件）。 */
const LEGACY_FILE: Record<DocType, string> = {
  concept: 'concept.md',
  world: 'world-building.md',
  outline: 'outline-detailed.md',
};

documentsRouter.get('/:id/document/:type', async (c) => {
  const docType = c.req.param('type') as DocType;
  if (!VALID_TYPES.has(docType)) {
    return c.json({ error: `Invalid document type: ${docType}` }, 400);
  }

  const novelDir = await resolveNovelDir(c.req.param('id'));
  const docDir = path.join(novelDir, DIR_MAP[docType]);
  const indexPath = path.join(docDir, 'index.md');

  // outline：合并读取前先自愈 index.md——从 chapters/ 卡片重建（章号取自文件名，
  // 修复章号显示为 ? 的问题）。自愈失败不影响后续读取。
  if (docType === 'outline') {
    try {
      await regenerateOutlineIndex(novelDir);
    } catch { /* 容错：读取流程继续走既有路径 */ }
  }

  // 优先读拆分格式（<docType>/index.md + 卡片）；不存在则回退旧单文件
  let indexContent: string;
  try {
    indexContent = await readFile(indexPath, 'utf-8');
  } catch {
    // 旧格式回退：读 .novel/<legacy-file>
    const legacyPath = path.join(novelDir, LEGACY_FILE[docType]);
    try {
      const legacyContent = await readFile(legacyPath, 'utf-8');
      return c.json({ content: legacyContent.trim() + '\n', sourceFile: LEGACY_FILE[docType] });
    } catch {
      return c.json({ error: `${docType} document not found` }, 404);
    }
  }

  // 读目录下所有卡片（排除 index.md），按文件名排序
  let entries: string[];
  try {
    entries = (await readdir(docDir, { recursive: true })) as string[];
  } catch {
    entries = [];
  }

  const cardFiles = entries
    .filter((f) => f !== 'index.md' && f.endsWith('.md'))
    .sort();

  const parts: string[] = [indexContent.trim(), ''];
  for (const relPath of cardFiles) {
    try {
      const content = await readFile(path.join(docDir, relPath), 'utf-8');
      parts.push(content.trim(), '');
    } catch { /* skip unreadable */ }
  }

  return c.json({ content: parts.join('\n').trim() + '\n', sourceFile: `${DIR_MAP[docType]}/index.md` });
});

export default documentsRouter;
