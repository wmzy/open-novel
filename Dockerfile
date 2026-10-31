# syntax=docker/dockerfile:1
# open-novel 生产镜像：多阶段构建，运行时只带生产依赖 + 构建产物。
# 所有可写状态收敛到 /data，配合 docker-compose.yml 的 named volume 持久化。

# ─── 阶段 1：安装全部依赖（含 devDependencies，供构建使用）───────────────────
FROM node:22-slim AS deps
# 与 CI（pnpm/action-setup@v4 version 11）同一大版本；锁文件由 pnpm 11 生成。
RUN npm install -g pnpm@11.28.0
WORKDIR /app
# 先只复制依赖清单，源码变动不失效 install 层缓存。
# pnpm-workspace.yaml 携带 allowBuilds（esbuild 等），缺了它全新安装会因
# ERR_PNPM_IGNORED_BUILDS 直接失败。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ─── 阶段 2：构建前端（dist/client）与服务端（dist/server/api.js）────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
# plugins/（插件清单 + SKILL.md）与 drizzle/（migration）是运行时数据，打进镜像。
COPY plugins ./plugins
COPY templates ./templates
COPY drizzle ./drizzle
RUN pnpm build

# ─── 阶段 3：仅安装生产依赖（Pi SDK 在 dependencies，随包进入运行时）─────────
FROM node:22-slim AS prod-deps
RUN npm install -g pnpm@11.28.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ─── 阶段 4：运行时镜像 ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    # 容器内必须监听 0.0.0.0 才能被端口映射访问；对外暴露请配 AUTH_TOKEN（见 README）。
    HOST=0.0.0.0 \
    # 全部可写状态：PGlite 库、定时备份、Pi 会话元数据、默认项目目录（HOME=/data
    # 使 ~/novels 解析到 /data/novels）。named volume 挂载 /data 即可整体持久化。
    OPEN_NOVEL_HOME=/data \
    PGLITE_DATA_DIR=/data/pglite \
    BACKUP_DIR=/data/backups \
    HOME=/data
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/templates ./templates
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
# node:22 镜像自带 uid=1000 的 node 用户。/data 预授权给 node：named volume
# 首次挂载按镜像内属主初始化；bind mount 则需宿主侧 chown 1000:1000（见 README）。
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3006
# slim 镜像没有 curl/wget；node 22 自带 fetch。/api/health 不受 AUTH_TOKEN 影响。
# db 异常时 health 返回 status=degraded，视为不健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3006)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/api.js"]
