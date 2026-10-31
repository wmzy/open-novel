#!/usr/bin/env node
/**
 * 发布前检查：npm 包必须包含运行所需的全部产物与随包资源。
 *
 * 用法：node scripts/verify-package-contents.mjs [pack-json 路径]
 * 默认读取 stdin（`npm pack --json --dry-run` 的输出）。
 * 缺任一必需文件即以非零退出——发布空壳包比不发布更糟。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 必需条目：文件精确匹配，或目录前缀匹配（drizzle/ 等目录）。 */
export const REQUIRED = [
  'dist/client/index.html',
  'dist/server/api.js',
  'bin/open-novel.mjs',
  'plugins/novel/SKILL.md',
  'plugins/wuxia/SKILL.md',
  'templates/CREATOR.md',
  'templates/progress.md',
  'templates/character-states.md',
  'templates/styles/README.md',
  'drizzle',
  'package.json',
  'README.md',
  'LICENSE',
];

export async function readInput(argPath) {
  if (argPath) return fs.readFileSync(argPath, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function parsePackJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('未读到 npm pack 输出');
  const parsed = JSON.parse(trimmed);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error('npm pack --json 输出里没有 files 列表');
  }
  return entry;
}

/** 返回缺失的必需条目（空数组 = 通过）。 */
export function findMissing(files) {
  return REQUIRED.filter((p) => !files.some((f) => f === p || f.startsWith(`${p}/`)));
}

export async function verify(raw) {
  const entry = parsePackJson(raw);
  const files = entry.files.map((f) => f.path);
  const missing = findMissing(files);
  if (missing.length > 0) {
    const error = new Error(`发布包缺少必需文件：${missing.join('、')}`);
    error.missing = missing;
    error.fileCount = files.length;
    throw error;
  }
  return { filename: entry.filename ?? '(dry-run)', fileCount: files.length };
}

/** 直接执行时跑 CLI（被 import 时不跑）。 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const raw = await readInput(process.argv[2]);
    const result = await verify(raw);
    console.log(
      `发布包内容检查通过：${result.filename}，${result.fileCount} 个文件，` +
      `必需条目 ${REQUIRED.length} 项齐全`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
