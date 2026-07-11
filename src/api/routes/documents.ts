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
import type { DocType } from '../../shared/split-document';

const documentsRouter = new Hono();

const VALID_TYPES = new Set<DocType>(['concept', 'world', 'outline']);

/** DocType → .novel/ 下的目录名。 */
const DIR_MAP: Record<DocType, string> = {
  concept: 'concept',
  world: 'world',
  outline: 'outline',
};

documentsRouter.get('/:id/document/:type', async (c) => {
  const docType = c.req.param('type') as DocType;
  if (!VALID_TYPES.has(docType)) {
    return c.json({ error: `Invalid document type: ${docType}` }, 400);
  }

  const novelDir = await resolveNovelDir(c.req.param('id'));
  const docDir = path.join(novelDir, DIR_MAP[docType]);

  let indexContent: string;
  try {
    indexContent = await readFile(path.join(docDir, 'index.md'), 'utf-8');
  } catch {
    return c.json({ error: `${docType} document not found` }, 404);
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

  return c.json({ content: parts.join('\n').trim() + '\n' });
});

export default documentsRouter;
