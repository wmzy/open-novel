import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { resolveProjectDir } from '../../shared/project-dir';
import {
  readCanon,
  readChapterContract,
  validateChapterContract,
  writeChapterContract,
} from '../../shared/canon';

const contractsRouter = new Hono();

async function projectDirOr404(projectId: string): Promise<{ dir: string } | { response: Response }> {
  try {
    return { dir: await resolveProjectDir(projectId) };
  } catch {
    return { response: Response.json({ error: 'Project not found' }, { status: 404 }) };
  }
}

function parseChapter(raw: string | undefined): number | null {
  const num = Number(raw);
  return Number.isInteger(num) && num >= 1 ? num : null;
}

contractsRouter.get('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const chapter = parseChapter(c.req.param('num'));
  if (chapter === null) return c.json({ error: 'Invalid chapter number' }, 400);
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const contract = await readChapterContract(resolved.dir, chapter);
  return c.json({ contract });
});

contractsRouter.put('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const chapter = parseChapter(c.req.param('num'));
  if (chapter === null) return c.json({ error: 'Invalid chapter number' }, 400);
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid contract body' }, 400);
  const contract = await writeChapterContract(resolved.dir, chapter, body);
  return c.json({ contract });
});

/** 运行确定性合同校验（不调用模型）。 */
contractsRouter.post('/:num/validate', async (c) => {
  const projectId = c.req.param('projectId')!;
  const chapter = parseChapter(c.req.param('num'));
  if (chapter === null) return c.json({ error: 'Invalid chapter number' }, 400);
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;

  const contract = await readChapterContract(resolved.dir, chapter);
  if (!contract) return c.json({ error: 'Contract not found' }, 404);

  const candidates = [
    `${resolved.dir}/.novel/chapters/第${chapter}章.md`,
    `${resolved.dir}/.novel/chapters/chapter-${chapter}.md`,
  ];
  let content = '';
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, 'utf-8');
      break;
    } catch { /* try next */ }
  }
  if (!content) return c.json({ error: `第${chapter}章正文不存在` }, 404);

  const canon = await readCanon(resolved.dir);
  const findings = validateChapterContract({ content, contract, canon });
  return c.json({
    chapter,
    findings,
    blockers: findings.filter((f) => f.severity === 'blocker').length,
    majors: findings.filter((f) => f.severity === 'major').length,
  });
});

export default contractsRouter;
