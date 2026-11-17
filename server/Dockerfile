# Ray BFF 生产镜像
# 数据库用 Node 内置的 node:sqlite（Node >= 23.4 无需 flag），
# 因此镜像不需要编译工具链，也不需要原生扩展。
FROM node:24-bookworm-slim

WORKDIR /app

RUN corepack enable

# 先只拷贝清单，命中层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json ./server/

RUN pnpm install --frozen-lockfile --filter @zh-deepseek/server

COPY server ./server

WORKDIR /app/server

ENV NODE_ENV=production \
    RAY_HOST=0.0.0.0 \
    RAY_PORT=3000 \
    RAY_DATA_DIR=/data

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RAY_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "--experimental-strip-types", "src/index.ts"]
