#!/usr/bin/env node
/**
 * open-novel 启动器（npx / 全局安装入口，package.json bin 指向这里）。
 *
 * 职责：校验构建产物存在 → 为数据目录提供安全默认值 → 动态加载
 * dist/server/api.js。HOST / PORT / AUTH_TOKEN 等服务配置全部由
 * src/config.ts 读取，这里不做二次解析。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(__dirname, '..', 'dist', 'server', 'api.js');
// 只读资源（templates/plugins/drizzle）相对包根解析；显式传给服务端，
// 兼容非常规安装布局（shared/package-root.ts 也支持向上查找 package.json）。
process.env.OPEN_NOVEL_PACKAGE_ROOT ||= path.resolve(__dirname, '..');

if (!fs.existsSync(distEntry)) {
  console.error(
    `[open-novel] 未找到构建产物：${distEntry}\n` +
      '当前包里没有 dist/。请改用发布包（见 README「部署」章节），' +
      '如果这是源码检出，请先在仓库根目录执行 pnpm build。',
  );
  process.exit(1);
}

// 数据根目录：PGlite 数据库、定时备份、Pi 会话元数据全部收纳在其下，
// 避免从任意 cwd 启动时在当前目录散落 ./data。已显式导出的变量一律不动。
const home = process.env.OPEN_NOVEL_HOME || path.join(os.homedir(), '.open-novel');
if (!process.env.OPEN_NOVEL_HOME) {
  process.env.OPEN_NOVEL_HOME = home;
  console.error(`[open-novel] OPEN_NOVEL_HOME 未设置，数据根目录使用默认值：${home}`);
}
process.env.PGLITE_DATA_DIR ||= path.join(home, 'pglite');
process.env.BACKUP_DIR ||= path.join(home, 'backups');

// 用 pathToFileURL 兼容 Windows 路径；dist 依赖包内 node_modules（安装时随包提供）。
await import(pathToFileURL(distEntry).href);
