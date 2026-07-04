import fs from 'node:fs/promises';
import path from 'node:path';

export interface RenameResult {
  filesModified: number;
  totalReplacements: number;
  /** 每个文件的替换数（相对路径 → 次数） */
  perFile: Record<string, number>;
}

export interface RenameOptions {
  /** 限定扫描的文件相对路径数组（相对于 projectDir）。省略 = 全 .novel 目录。 */
  scope?: string[];
}

/**
 * 检测 oldName 是否是其他全名的子串。
 * CJK 无词边界，若 oldName 是某个更长全名的子串（如 oldName="沈" 命中 "宋江"），
 * 精确替换会误伤，需调用方改用更长的全名。
 * @param oldName 要替换的名字
 * @param allNames profiles.md 中提取的所有角色全名
 * @returns 包含 oldName 为子串的其他全名列表（精确匹配自身的不算）
 */
export function findSubstringConflicts(oldName: string, allNames: string[]): string[] {
  if (!oldName) return [];
  return allNames.filter((n) => n !== oldName && n.includes(oldName));
}

/**
 * 扫描 .novel 目录下所有需要做替换的文件路径。
 * 包括 .md 文件 + state.json + foreshadow.json + outline-meta.json。
 */
async function collectTargetFiles(projectDir: string, scope?: string[]): Promise<string[]> {
  if (scope && scope.length > 0) {
    // scope 项解析为绝对路径；不存在的文件由后续 readFile 的 try/catch 跳过
    return scope.map((s) => (path.isAbsolute(s) ? s : path.join(projectDir, s)));
  }
  // 全 .novel 扫描
  const novelDir = path.join(projectDir, '.novel');
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (
        entry.endsWith('.md') ||
        entry === 'state.json' ||
        entry === 'foreshadow.json' ||
        entry === 'outline-meta.json'
      ) {
        results.push(full);
      }
    }
  }

  await walk(novelDir);
  return results;
}

/** 统计子串出现次数（不依赖正则，避免特殊字符问题）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 执行确定性重命名：在所有目标文件中将 oldName 精确替换为 newName。
 * 零 agent 调用，瞬时完成。
 */
export async function performRename(
  projectDir: string,
  oldName: string,
  newName: string,
  options?: RenameOptions,
): Promise<RenameResult> {
  if (!oldName || !newName || oldName === newName) {
    return { filesModified: 0, totalReplacements: 0, perFile: {} };
  }

  const files = await collectTargetFiles(projectDir, options?.scope);
  let filesModified = 0;
  let totalReplacements = 0;
  const perFile: Record<string, number> = {};

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const count = countOccurrences(content, oldName);
    if (count === 0) continue;

    // split/join 等价于 replaceAll，兼容旧运行时
    const newContent = content.split(oldName).join(newName);
    await fs.writeFile(filePath, newContent, 'utf-8');

    filesModified++;
    totalReplacements += count;
    perFile[path.relative(projectDir, filePath)] = count;
  }

  return { filesModified, totalReplacements, perFile };
}
