import fs from 'node:fs/promises';
import path from 'node:path';
import { parseOutlineMeta } from '../shared/outline-meta';

const NOVEL_DIR = '.novel';
const OUTLINE_FILE = 'outline-detailed.md';

/** 读取 .novel/ 下文本文件，失败返回空串。 */
async function readNovelFile(projectDir: string, rel: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(projectDir, NOVEL_DIR, rel), 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** 判断章号 N 是否落在范围锚点（如"第16-17章"/"第27-30章"）内。 */
function chapterInRange(anchorNums: number[], target: number): boolean {
  if (anchorNums.length === 1) return anchorNums[0] === target;
  return target >= anchorNums[0] && target <= anchorNums[anchorNums.length - 1];
}

/** 从大纲全文提取第 N 章块。 */
export async function extractChapterOutline(
  projectDir: string,
  chapter: number,
): Promise<string> {
  const raw = await readNovelFile(projectDir, OUTLINE_FILE);
  if (!raw) return '';

  const lines = raw.split('\n');
  const anchorRe = /^####\s+第([\d]+(?:-[\d]+)*)章/;
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (!m) continue;
    const nums = m[1].split('-').map((n) => parseInt(n, 10));
    if (chapterInRange(nums, chapter)) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) {
    return `> [第${chapter}章未在 outline-detailed.md 中规划]`;
  }

  // 截取到下一个 #### 或 ### 之前
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join('\n').trim();
}

export interface Cast {
  pov: string;
  /** L1 完整注入角色名 */
  full: string[];
  /** L2 速查角色名 */
  brief: string[];
}

const META_FILE = 'outline-meta.json';

/** 从大纲块表格解析 POV 与出场角色。 */
function parseCastFromBlock(block: string): { pov: string; cast: string[] } {
  if (!block) return { pov: '', cast: [] };
  const lines = block.split('\n');
  let pov = '';
  const cast: string[] = [];
  for (const line of lines) {
    const povM = line.match(/^\|\s*POV\s*\|\s*(.+?)\s*\|/);
    if (povM) {
      pov = povM[1].replace(/（.*?）/g, '').trim();
      continue;
    }
    const castM = line.match(/^\|\s*出场角色\s*\|\s*(.+?)\s*\|/);
    if (castM) {
      const cleaned = castM[1].replace(/（.*?）/g, '');
      for (const part of cleaned.split(/[、，,]/)) {
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
