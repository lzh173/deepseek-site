# Ray BFF 生产镜像
# better-sqlite3 在没有预编译包的平台上需要从源码编译，因此保留构建工具链。
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

# 先只拷贝清单，命中层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json ./server/

RUN pnpm install --frozen-lockfile --filter @ray/server

COPY server ./server

WORKDIR /app/server

ENV NODE_ENV=production \
    RAY_HOST=0.0.0.0 \
    RAY_PORT=3000 \
    RAY_DATA_DIR=/data

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RAY_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "--experimental-strip-types", "src/index.ts"]
