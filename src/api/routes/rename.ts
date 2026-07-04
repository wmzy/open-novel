import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir } from '../../shared/project-dir';
import { performRename, findSubstringConflicts } from '../../shared/rename';
import { checkName } from '../../shared/naming/name-checker';
import { createSnapshot } from '../../agent/snapshot';
import { syncFilesToDb } from '../../agent/artifacts';

const renameRouter = new Hono();

/**
 * 解析 .novel/characters/profiles.md 中的角色全名列表。
 * 复用 naming 路由相同的标题正则，去掉括号批注。
 */
async function loadAllCharacterNames(projectDir: string): Promise<string[]> {
  try {
    const content = await readFile(
      path.join(projectDir, '.novel', 'characters', 'profiles.md'),
      'utf-8',
    );
    const names: string[] = [];
    const headingRe = /^##\s+(.+?)$/gm;
    let match: RegExpExecArray | null;
    while ((match = headingRe.exec(content)) !== null) {
      const raw = match[1].trim();
      const parenStripped = raw.replace(/[（(][^)）]*[)）]/g, '').trim();
      // 去掉开头的序号前缀，如 "一、" / "1." / "1、"
      const clean = parenStripped.replace(/^(?:[一二三四五六七八九十]+|[0-9]+)[、.．]\s*/, '').trim();
      if (clean) names.push(clean);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * 确定性重命名端点（机械层）。
 *
 * POST /api/projects/:projectId/rename
 * body: { oldName: string, newName: string, scope?: string[] }
 *
 * 流程：预检 checkName(newName) → 子串冲突检测 → 扫描替换 → git 快照 → 回写 DB。
 * 零 agent 调用，瞬时完成。
 */
renameRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;

  let body: { oldName?: string; newName?: string; scope?: string[] } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { oldName, newName, scope } = body;
  if (!oldName || !newName) {
    return c.json({ error: 'oldName and newName are required' }, 400);
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const allNames = await loadAllCharacterNames(projectDir);

  // 1. 预检：checkName(newName) —— 谐音/碰撞/语音/相似/生僻
  const preCheck = checkName(newName, allNames.filter((n) => n !== oldName));
  if (preCheck.warnings.length > 0) {
    return c.json(
      { error: 'precheck_failed', warnings: preCheck.warnings, checks: preCheck.checks },
      409,
    );
  }

  // 2. 子串冲突检测：oldName 不能是其他全名的子串（CJK 无词边界防误伤）
  const conflicts = findSubstringConflicts(oldName, allNames);
  if (conflicts.length > 0) {
    return c.json(
      {
        error: 'precheck_failed',
        substringConflicts: conflicts,
        message: `"${oldName}" 是以下全名的子串，请使用精确全名：${conflicts.join('、')}`,
      },
      409,
    );
  }

  // 3. 执行确定性替换
  const result = await performRename(
    projectDir,
    oldName,
    newName,
    scope ? { scope } : undefined,
  );

  // 4. git 快照（失败不影响结果，仅丧失回滚点）
  const snapshot = await createSnapshot(
    projectDir,
    `rename: ${oldName}→${newName}, ${result.filesModified} files, ${result.totalReplacements} replacements`,
  ).catch(() => null);

  // 5. 回写 DB（章节记录可能有标题/字数变化）
  if (result.filesModified > 0) {
    await syncFilesToDb(
      projectId,
      new Set(Object.keys(result.perFile)),
      projectDir,
    ).catch(() => {});
  }

  return c.json({
    filesModified: result.filesModified,
    totalReplacements: result.totalReplacements,
    perFile: result.perFile,
    snapshot,
    newNameValid: true,
  });
});

export default renameRouter;
