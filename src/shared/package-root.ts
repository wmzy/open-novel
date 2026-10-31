/**
 * 运行时资源根目录解析（npm 包 / tarball / Docker / 源码检出通用）。
 *
 * 背景：`process.cwd()` 只代表「用户启动服务的目录」——npx 全局安装时它是
 * 用户的项目目录，而不是 open-novel 包目录。模板、插件、migration 都属于
 * 随包分发的只读资源，必须相对包根解析，否则 `npx @wmzy/open-novel` 会：
 * - 找不到 `templates/`，新项目缺少 CREATOR/progress/character-states 初始文件；
 * - 找不到 `plugins/`，所有创作技能与模板消失；
 * - 找不到 `drizzle/`，PGlite 首次启动没有 migration 可跑。
 *
 * 解析顺序：
 * 1. `OPEN_NOVEL_PACKAGE_ROOT`（显式覆盖，测试/非常规部署用）；
 * 2. 从当前模块文件向上查找含 `package.json` 的目录（源码与 esbuild 产物都适用：
 *    源码位于 <root>/src/shared/，产物位于 <root>/dist/server/api.js）；
 * 3. 兜底 `process.cwd()`（保持历史行为）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

/** 包根目录（含 package.json）。结果缓存；测试可设置 OPEN_NOVEL_PACKAGE_ROOT。 */
export function packageRoot(): string {
  const override = process.env.OPEN_NOVEL_PACKAGE_ROOT?.trim();
  if (override) return path.resolve(override);
  if (cachedRoot) return cachedRoot;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedRoot = process.cwd();
  return cachedRoot;
}

/** 随包分发的只读资源目录（templates/plugins/drizzle）。 */
export function packageResource(...parts: string[]): string {
  return path.join(packageRoot(), ...parts);
}

/** 项目初始化模板（CREATOR.md / progress.md / character-states.md / styles）。 */
export function packageTemplatesDir(): string {
  return packageResource('templates');
}

/** 内置技能插件目录（wuxia 等）。 */
export function packagePluginsDir(): string {
  return packageResource('plugins');
}

/** Drizzle migration 目录；`DRIZZLE_MIGRATIONS_FOLDER` 仍可显式覆盖。 */
export function packageMigrationsDir(): string {
  return process.env.DRIZZLE_MIGRATIONS_FOLDER?.trim() || packageResource('drizzle');
}
