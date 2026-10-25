/**
 * .novel/config.json 读写（项目级设置）。
 *
 * 项目设置此前散落在 runs.ts / projects.ts 的局部 readFile 中；里程碑设置
 * （milestoneEvery）也需要读取它。集中到此处，写入采用临时文件 + rename。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readNovelConfig(projectDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir, '.novel', 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

export async function writeNovelConfig(
  projectDir: string,
  config: Record<string, unknown>,
): Promise<void> {
  const file = path.join(projectDir, '.novel', 'config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * P1-a：写作 run 成功后是否自动提取 canon 变更（LLM 语义提取）。
 * 默认开；只有显式写 false 才关闭（缺省/非法值均视为开）。
 */
export async function readCanonAutoExtract(projectDir: string): Promise<boolean> {
  const raw = (await readNovelConfig(projectDir)).canonAutoExtract;
  return raw !== false;
}

/** 自动里程碑间隔（章）。默认 50；0 表示关闭；非法值回退默认。 */
export async function readMilestoneEvery(projectDir: string): Promise<number> {
  const raw = (await readNovelConfig(projectDir)).milestoneEvery;
  if (raw === undefined || raw === null) return 50;
  if (typeof raw === 'string' && raw.trim() === '') return 50;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.floor(n);
}
