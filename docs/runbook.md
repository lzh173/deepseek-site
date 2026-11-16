# Ray 运行手册

> 目标文档见 [GOAL.md](../GOAL.md)，架构与协议契约以它为准。本文件只讲怎么跑起来。

## 0. 一览

```
浏览器 ──► BFF (Fastify, :3000) ──► 渠道池（OpenAI 兼容上游）
              │
              ├── SQLite (data/ray.db)
              └── 附件 (data/files/<sha256>)
```

- 聊天页：`/`
- 管理后台：`/admin.html`
- 健康检查：`/api/health`

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 24** | 用到内置 `node:sqlite` 与 TS 类型剥离 |
| pnpm | 12.x | 通过 `corepack enable` 安装即可 |
| 磁盘 | ≥ 1 GB | 依赖约 340 MB，数据按实际增长 |

> 不需要编译工具链、不需要外部数据库。

## 2. 首次启动（本地）

```powershell
cd E:\CODEX-NOworkspaces\deepseek-lzh
pnpm install
pnpm build                      # 产出 dist/（index.html + admin.html）

cd server
copy .env.example .env          # 然后编辑
#   RAY_ADMIN_PASSWORD=你的密码
#   RAY_DATA_DIR=../data
#   （可选）RAY_UPSTREAM_* 用于首次自动建渠道+Key+模型
pnpm start
```

启动后：

- 管理员账号：`admin`（或 `.env` 里的 `RAY_ADMIN_USER`）
- 密码：`.env` 里的 `RAY_ADMIN_PASSWORD`；没配则会在控制台打印一次随机密码
- 如果配了 `RAY_UPSTREAM_BASE_URL` / `_API_KEY` / `_MODEL`，首次启动会自动创建
  一条「默认上游」渠道、一把 Key 和一个 `ray-chat` 模型，可以直接聊天

## 3. 日常开发

两个终端：

```powershell
# 终端 1：BFF（带 --watch 自动重启）
cd server
pnpm dev

# 终端 2：前端（8090，/api 已代理到 127.0.0.1:3000）
pnpm dev
```

浏览器打开 http://localhost:8090 。管理后台是 http://localhost:8090/admin.html 。

## 4. 生产部署（单机 Docker）

```powershell
copy server\.env.example server\.env   # 填 RAY_MASTER_KEY / 管理员密码
docker compose --env-file server/.env up -d --build
```

- 镜像构建在 `server/Dockerfile`，`node:24-bookworm-slim`，无编译依赖
- 数据卷 `ray-data` 挂到容器 `/data`
- 端口只绑 `127.0.0.1:3000`，外网入口交给 Cloudflare Tunnel / Access（见 GOAL §15）
- 走 HTTPS 时 `.env` 里设 `RAY_COOKIE_SECURE=true`

想让 BFF 一并托管前端产物，把构建好的 `dist` 挂进容器并设 `RAY_WEB_DIR=/app/dist`；
否则用 Caddy / Cloudflare Pages 托管 `dist`，把 `/api` 反代到 3000 即可。

## 5. 管理后台

登录后（需 admin 角色）七页：

| 页面 | 用途 |
|---|---|
| 仪表盘 | 渠道/Key 概况、最近错误 |
| 渠道 | 上游 Base URL、协议类型、付费/免费、优先级、探活 |
| 账号池 | 批量导入 Key（一行一把）、掩码展示、测试、重置冷却、编辑 Key×模型映射 |
| 模型 | 公开模型 + 能力位（vision/reasoning/web_search/read_url/file_parse） |
| 用户 | 建号、配额、**付费白名单（Key × 模型 + 有效期）** |
| 日志 | 按 ray / 用户 / 模型 / 状态 / 时间筛选 |
| 系统 | 磁盘与表统计、清理孤儿文件 |

**配一个新上游的最小步骤**：渠道 → 账号池传 Key → 模型 → 在该 Key 上「编辑映射」
（public_model ↔ upstream_model）→ 普通用户还需在「用户」页授以「模型 × Key」。

想让图片能进模型：给模型勾上 `vision` 能力位，并把支持图片的上游模型映射到一把 Key。
前端检测到当前模型 `vision=false` 且有图片附件时，会在输入框上方出现降级提示条。

## 5.1 联网搜索

- `docker compose` 已内置 `searxng` 服务，`RAY_SEARXNG_URL` 默认指向它。
- 本地不需要搜索时可以不配，BFF 会退化为 DuckDuckGo 抓取；都失败也不会影响对话。
- 搜索结果会先以「来源卡片」形式出现在回答前，再作为上下文注入模型。

## 6. 数据与备份

| 路径 | 内容 |
|---|---|
| `data/ray.db`（+ `-wal`/`-shm`） | 会话、用户、渠道、Key（密文）、用量 |
| `data/files/<前两位>/<sha256>` | 附件原件，按内容寻址去重 |
| `data/.master-key` | Key 加密主密钥（若未用 `RAY_MASTER_KEY` 指定） |

备份：停服后整目录 `rsync`/`robocopy` 即可。**`.master-key` 必须一起备份**，
否则 `keys.key_cipher` 无法解密，等于所有上游 Key 作废。

## 7. 故障排查

- **每个错误都带 `ray_xxxxxxxxxxxx`**：拿它去「日志」页或直接查
  `SELECT * FROM usage_log WHERE ray = ?`。
- **「服务器繁忙（请求编号：…）」**：所有可用 Key 都失败/冷却了。看「账号池」的
  状态列，或日志里 `status='busy'` 的记录。
- **上传报「文件过大」/「解析失败」**：限额见 GOAL §11.1，服务端为准。
- **Cookie 不生效**：`RAY_COOKIE_SECURE=true` 时必须是 HTTPS 访问。

## 8. 已知限制

- 历史记录的导入导出仍是浏览器端 ZIP 解析，服务端暂存能力未实现。
- 「二段式模拟思考」未做：模型不支持 reasoning 时，前端直接隐藏深度思考开关。
- 图片 OCR 分支未做：看不了图的模型会引导用户「换视觉模型」或「让视觉模型转述」。
- 语音为浏览器兜底（Web Speech），没有服务端 whisper。
- 管理端写操作暂无独立审计表。
- PDF 只认文本层：扫描件抽不出内容，会显示「无法解析该文档」占位。
