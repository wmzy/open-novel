import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { generatePersonNames } from '../../shared/naming/name-generator';
import { checkName } from '../../shared/naming/name-checker';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const namingRouter = new Hono();

const DESCRIPTION_TO_IMAGERY: Record<string, string[]> = {
  '沉默': ['深沉', '孤独', '隐忍'],
  '寡言': ['深沉', '沉默'],
  '深沉': ['深沉', '幽暗', '包容'],
  '家道中落': ['衰败', '苍凉', '沧桑'],
  '衰败': ['衰败', '苍凉'],
  '孤独': ['孤独', '漂泊', '空旷'],
  '漂泊': ['漂泊', '远方'],
  '复仇': ['残破', '苍凉', '锋芒'],
  '正义': ['光明', '正义', '坚定'],
  '温婉': ['温柔', '雅致', '华美'],
  '冷傲': ['清冷', '寒冷', '孤傲'],
  '隐逸': ['隐逸', '淡泊', '自由'],
  '刚毅': ['坚定', '刚硬', '坚韧'],
  '聪明': ['洞察', '见识', '明亮'],
  '善良': ['光明', '纯净', '温润'],
  '神秘': ['幽暗', '神秘', '深沉'],
  '书卷': ['文墨', '书卷', '淡泊'],
  '江湖': ['江湖', '漂泊', '锋芒'],
  '清冷': ['清冷', '寒冷'],
  '高洁': ['高洁', '纯净'],
  '思念': ['思念', '怀旧'],
};

function deriveImagery(description: string): string[] {
  const matched = new Set<string>();
  for (const [key, words] of Object.entries(DESCRIPTION_TO_IMAGERY)) {
    if (description.includes(key)) {
      for (const w of words) matched.add(w);
    }
  }
  return matched.size > 0 ? [...matched] : ['深沉', '远方', '孤独'];
}

/**
 * 解析 .novel/characters/profiles.md 中的已有角色名。
 * 按行匹配 /^##\s+(.+?)$/ 取标题名，去掉括号批注（如 "萧瑟（男主）" → "萧瑟"）。
 */
async function loadExistingNames(projectDir: string): Promise<string[]> {
  try {
    const content = await readFile(
      path.join(projectDir, 'characters', 'profiles.md'),
      'utf-8',
    );
    const names: string[] = [];
    const headingRe = /^##\s+(.+?)$/gm;
    let match: RegExpExecArray | null;
    while ((match = headingRe.exec(content)) !== null) {
      const raw = match[1].trim();
      // 去掉括号批注，如 "萧瑟（男主）" → "萧瑟"
      const clean = raw.replace(/[（(][^)）]*[)）]/g, '').trim();
      if (clean) names.push(clean);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * 人名生成。
 * body: { category, description, region?, gender?, surnameConstraint?, count? }
 */
namingRouter.post('/generate', async (c) => {
  const projectId = c.req.param('projectId')!;

  let body: {
    category?: string;
    description: string;
    region?: string;
    gender?: string;
    surnameConstraint?: string;
    count?: number;
  } = { description: '' };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.description) {
    return c.json({ error: 'description is required' }, 400);
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const existingNames = await loadExistingNames(projectDir);
  const imageryKeywords = deriveImagery(body.description);

  const candidates = generatePersonNames({
    imageryKeywords,
    region: body.region,
    gender: body.gender === '不限' ? undefined : (body.gender as 'male' | 'female' | 'neutral' | undefined),
    surnameConstraint: body.surnameConstraint,
    existingNames,
    count: body.count,
  });

  return c.json({
    candidates,
    context: {
      region: body.region ?? '模糊古代',
      imageryKeywords,
      networkUsed: false,
    },
  });
});

/**
 * 名字检查。
 * body: { name: string, existingNames?: string[] }
 */
namingRouter.post('/check', async (c) => {
  let body: { name?: string; existingNames?: string[] } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const result = checkName(body.name, body.existingNames || []);
  return c.json({
    checks: result.checks,
    warnings: result.warnings,
    reject: result.reject,
  });
});

export default namingRouter;