import fs from 'node:fs/promises';
import path from 'node:path';

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
