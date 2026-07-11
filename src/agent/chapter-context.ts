import fs from 'node:fs/promises';
import path from 'node:path';
import { parseOutlineMeta } from '../shared/outline-meta';

const NOVEL_DIR = '.novel';
const OUTLINE_CHAPTERS_DIR = path.join('outline', 'chapters');

/** 读取 .novel/ 下文本文件，失败返回空串。 */
async function readNovelFile(projectDir: string, rel: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(projectDir, NOVEL_DIR, rel), 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** 从大纲目录读取第 N 章卡片文件。 */
export async function extractChapterOutline(
  projectDir: string,
  chapter: number,
): Promise<string> {
  const content = await readNovelFile(projectDir, `${OUTLINE_CHAPTERS_DIR}/第${chapter}章.md`);
  if (!content) return `> [第${chapter}章未在 outline/chapters/ 中规划]`;
  return content;
}

export interface Cast {
  pov: string;
  /** L1 完整注入角色名 */
  full: string[];
  /** L2 速查角色名 */
  brief: string[];
}

const META_FILE = 'outline-meta.json';

/** 从大纲块解析 POV 与出场角色（支持表格格式和 bullet 格式）。 */
function parseCastFromBlock(block: string): { pov: string; cast: string[] } {
  if (!block) return { pov: '', cast: [] };
  const lines = block.split('\n');
  let pov = '';
  const cast: string[] = [];
  for (const line of lines) {
    // 表格格式：| POV | 林青 |
    const povM = line.match(/^\|\s*POV\s*\|\s*(.+?)\s*\|/);
    if (povM) {
      pov = povM[1].replace(/（.*?）/g, '').trim();
      continue;
    }
    const castM = line.match(/^\|\s*出场角色\s*\|\s*(.+?)\s*\|/);
    if (castM) {
      const cleaned = castM[1].replace(/（.*?）/g, '');
      for (const part of cleaned.split(/[、，，]/)) {
        const n = part.trim();
        if (n && n !== '（路人）' && n !== '群像') cast.push(n);
      }
      continue;
    }
    // Bullet 格式：- **POV**：林青  或  - **视点**：林青
    const bulletPovM = line.match(/^[-*]\s*\*\*(?:POV|视点)\*\*[：:]\s*(.+)/);
    if (bulletPovM) {
      pov = bulletPovM[1].replace(/（.*?）/g, '').trim();
      continue;
    }
    const bulletCastM = line.match(/^[-*]\s*\*\*出场角色\*\*[：:]\s*(.+)/);
    if (bulletCastM) {
      const cleaned = bulletCastM[1].replace(/（.*?）/g, '');
      for (const part of cleaned.split(/[、，，]/)) {
        const n = part.trim();
        if (n && n !== '（路人）' && n !== '群像') cast.push(n);
      }
    }
  }
  return { pov, cast };
}

/** 第 N 章出场角色识别（三级回退）。 */
export async function identifyCast(
  projectDir: string,
  chapter: number,
  outlineBlock: string,
  knownNames: string[] = [],
): Promise<Cast> {
  // Level 1: outline-meta.json pov
  const metaRaw = await readNovelFile(projectDir, META_FILE);
  if (metaRaw) {
    try {
      const meta = parseOutlineMeta(JSON.parse(metaRaw));
      if (meta) {
        const entry = meta.chapters.find((c) => c.chapter === chapter);
        if (entry && entry.pov) {
          return { pov: entry.pov, full: [entry.pov], brief: [] };
        }
      }
    } catch { /* 格式错误，降级 */ }
  }

  // Level 2: outline block 表格
  const { pov, cast } = parseCastFromBlock(outlineBlock);
  if (pov || cast.length > 0) {
    const fullSet = new Set<string>([pov, ...cast].filter(Boolean));
    return { pov, full: [...fullSet], brief: [] };
  }

  // Level 3: name matching against known names
  if (knownNames.length === 0 || !outlineBlock) {
    return { pov: '', full: [], brief: [] };
  }
  const mentioned: string[] = [];
  for (const name of knownNames) {
    if (outlineBlock.includes(name)) mentioned.push(name);
  }
  if (mentioned.length === 0) return { pov: '', full: [], brief: [] };
  // 区分主要互动者（与 POV 紧邻“和/与/跟”连接）与仅被提及者
  const povName = mentioned[0];
  const fullSet = new Set<string>([povName]);
  const briefSet = new Set<string>();
  for (const name of mentioned.slice(1)) {
    // 与 POV 紧邻“和/与/跟”连接（中间不含句号/逗号分隔）→ full；其余仅被提及 → brief
    const adjacent = new RegExp(`${povName}[和与跟][^。，,！？]*?${name}|${name}[和与跟][^。，,！？]*?${povName}`).test(outlineBlock);
    if (adjacent) {
      fullSet.add(name);
    } else {
      briefSet.add(name);
    }
  }
  return { pov: povName, full: [...fullSet], brief: [...briefSet] };
}

const PROFILES_DIR = path.join('characters', 'profiles');
const L1_BUDGET_PER_CHAR = 6 * 1024; // 6KB
const LAYER_TOTAL_BUDGET = 20 * 1024; // 20KB

/** L1 关键段优先级（高→低），其余段截断跳过。 */
const KEY_SECTIONS = ['出身与经历', '时间线', '驱动力三角', '性格', '语言', '基本信息', '外貌'];

/** 按 ## 标题切片，提取关键段。 */
function extractKeySections(profile: string): string {
  const sections = profile.split(/\n(?=##\s)/);
  const picked: string[] = [];
  let size = 0;
  for (const key of KEY_SECTIONS) {
    const sec = sections.find((s) => new RegExp(`^##\\s.*${key}`).test(s));
    if (sec) {
      picked.push(sec);
      size += sec.length;
      if (size > L1_BUDGET_PER_CHAR) break;
    }
  }
  if (picked.length === 0) {
    return profile.slice(0, 2 * 1024) + `\n\n[完整档案见 …]`;
  }
  let result = picked.join('\n\n');
  if (result.length > L1_BUDGET_PER_CHAR) {
    result = result.slice(0, L1_BUDGET_PER_CHAR) + `\n\n[完整档案见 …]`;
  }
  return result;
}

/** L2 速查卡：首段 + 标志细节。 */
function buildBriefCard(name: string, profile: string): string {
  const firstPara = profile.split(/\n(?=##\s)/)[0].replace(/^#\s.*\n/, '').trim();
  return `- **${name}**（速查）：${firstPara.slice(0, 150)}`;
}

/** 构建出场角色层。 */
export async function buildCastLayer(projectDir: string, cast: Cast): Promise<string> {
  const { pov, full, brief } = cast;
  if (!pov && full.length === 0 && brief.length === 0) return '';

  const sections: string[] = ['### 本章出场角色层'];
  let totalSize = 0;

  // L1: full 列表（POV 优先）
  for (const name of full) {
    const profilePath = path.join(projectDir, NOVEL_DIR, PROFILES_DIR, `${name}.md`);
    let profile: string;
    try {
      profile = (await fs.readFile(profilePath, 'utf-8')).trim();
    } catch {
      continue; // 文件缺失，跳过
    }
    if (totalSize + profile.length > LAYER_TOTAL_BUDGET) {
      sections.push(buildBriefCard(name, profile));
      totalSize += 200;
      continue;
    }
    const extracted = extractKeySections(profile);
    const label = name === pov ? '（POV）' : '';
    // 声口样本（可选资产，文件存在时附入）
    const voicesPath = path.join(projectDir, NOVEL_DIR, 'characters', 'voices', `${name}.md`);
    let voiceBlock = '';
    try {
      const voices = (await fs.readFile(voicesPath, 'utf-8')).trim();
      if (voices) voiceBlock = `\n\n**声口样本**\n${voices}`;
    } catch { /* 可选资产，缺失即跳过 */ }
    const block = `${extracted}${voiceBlock}`;
    sections.push(`#### ${name}${label}\n${block}`);
    totalSize += block.length;
  }

  // L2: brief 列表
  for (const name of brief) {
    const profilePath = path.join(projectDir, NOVEL_DIR, PROFILES_DIR, `${name}.md`);
    let profile: string;
    try {
      profile = (await fs.readFile(profilePath, 'utf-8')).trim();
    } catch {
      continue;
    }
    sections.push(buildBriefCard(name, profile));
  }

  return sections.join('\n\n');
}
