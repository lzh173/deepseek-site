# ZH DeepSeek

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造的多渠道 AI 聊天服务。
外观与 DeepSeek 网页端一致，后端自建：多个上游渠道 + Key 账号池 + 账号分层，所有原本由 DeepSeek
服务端提供的能力（搜索、读链接、文档解析、OCR、语音合成与识别、图片理解）都在本地实现，
其中能用官方 API 的优先走官方，其余有免费兜底。

- **许可**：[AGPL-3.0](./LICENSE)（上游 MIT 声明保留在 LICENSE 末尾）
- **源码**：https://github.com/lzh173/deepseek-site
- **运行要求**：Node.js ≥ 24 + pnpm

---

## 特性

### 对话

- 流式回复、Markdown / 代码高亮 / KaTeX 公式 / Mermaid 图表
- **深度思考**：`reasoning_content` → 可折叠的思考面板；模型不支持时自动隐藏开关
- 多会话、消息分支、编辑重发、重新生成、继续生成
- 中英双语、亮/暗主题、移动端布局、历史记录导入导出（ZIP）

### 联网与资料

- **联网搜索**：模型先生成搜索词 → 官方 Search API（重排 + 长摘要）→ 失败回退本地抓取
- **读链接**：官方 Fetch（Markdown 正文）→ 回退本地抽取（含 SSRF 防护）
- **文档解析**：PDF / Word / PPT / Excel 由本地库抽取，扫描件自动升级为官方 OCR
- **图片理解**：支持视觉的模型直接内联图片；不支持时引导「换模型」或「让视觉模型转述」

### 语音与 OCR

- **TTS 朗读**：官方 `/v1/tools/tts`（海星 / 暗潮两种音色），可切浏览器 `speechSynthesis`
- **ASR 语音输入**：官方 `/v1/tools/asr`，可切浏览器 `SpeechRecognition`
- **OCR**：图片 / PDF / Office 逐页识别，结果可在设置页一键测试并复制

### 渠道与账号

- 渠道类型：**DeepSeek 官方** / OpenAI 兼容 / Anthropic / Gemini / Ollama
- **Key 账号池**：同一渠道多把 Key，AES-256-GCM 加密存储，按最闲优先轮询，429/5xx 自动冷却，401 自动禁用
- **Key × 模型 多对多**：同一把 Key 能调哪些模型逐条登记，路由只看这张表
- **三层账号**：

  | 账号 | 模型 | 官方能力 |
  |---|---|---|
  | 管理员 | 全部（含付费） | 全部 |
  | 授权账号（有 grants） | 被授权的付费模型 + 免费模型 | 全部 |
  | 免费账号 | 仅免费模型 | 语音 / OCR 走浏览器兜底 |

- 付费白名单粒度到 **Key × 模型**，可设有效期；授权集合是故障转移的硬边界

### 运维

- 每个请求一个 `ray_xxxxxxxxxxxx` 编号，错误信息里直接带出来，后台可按编号检索
- 统一错误语义：401 未登录 / 403 无权限 / 429 配额 / 503 服务器繁忙（前端据此区分「重试」与「无权限」）
- SQLite WAL + 附件 sha256 内容寻址去重；孤儿文件定时清理
- 管理后台：仪表盘、渠道、账号池、模型、用户与白名单、日志、系统

---

## 快速开始

```bash
git clone https://github.com/lzh173/deepseek-site.git
cd deepseek-site
pnpm install
pnpm build

cp server/.env.example server/.env
# 至少填 RAY_ADMIN_PASSWORD
cd server && pnpm start
```

打开 http://127.0.0.1:3000/ ，用 `.env` 里的账号登录。

### 首次配置上游

**推荐：官方渠道（只需贴 Key）**

1. 管理后台 → 渠道 → 新建，类型选 **DeepSeek 官方**，只填名称
   （服务端会固定 `https://api.deepseek.com`、`paid` 层级，并自动建好 `deepseek-flash` / `deepseek-v4-pro`）
2. 账号池 → 选中该渠道 → 粘贴 API Key
   （**Key 会自动映射到这两个模型**，无需手工配映射）

**或者：任意 OpenAI 兼容上游**

1. 渠道 → 新建，填 Base URL（多数服务要带 `/v1`，例如 `https://openrouter.ai/api/v1`）
2. 账号池 → 导入 Key（一行一把）
3. 模型 → 新建公开模型 → 回到账号池，点该 Key 的「编辑映射」填写 `公开名 ↔ 上游真实模型名`

> 渠道页的「测试」会真的请求 `{base_url}/models` 并校验返回是不是 JSON 模型列表，
> 地址少了 `/v1` 会直接提示你。

---

## 设置

设置弹窗有四个分区：

| 分区 | 内容 |
|---|---|
| 通用设置 | 模型、主题、语言、朗读音色、位置 |
| 能力与账号 | 账号层级、六项能力的来源切换、OCR 自测 |
| 数据管理 | 当前账号、导入 / 导出历史、删除全部对话 |
| 关于 | 版本、源码仓库、许可、上游归属 |

「能力与账号」里每项能力可以选 **自动 / 官方 / 浏览器 / 关闭**：

- **自动**：有官方能力就用官方（默认）
- **官方**：强制走 DeepSeek 官方接口（按次计费）
- **浏览器**：TTS / ASR 强制走 Web Speech，服务端返回 501，不产生官方费用
- **关闭**：彻底停用

偏好存服务端 `user_prefs`，跨设备生效；免费账号的下拉里不会出现「官方」。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 · rspack 2 · zustand 4 · TypeScript 7 · CSS Modules |
| 渲染 | mdast / micromark · Prism · KaTeX · Mermaid |
| 后端 | Fastify 5 · TypeScript 7（`node --experimental-strip-types`，无构建步骤） |
| 数据库 | `node:sqlite`（Node 内置，无原生编译依赖） |
| 鉴权 | argon2 + `auth_sessions` 表（token 哈希，可即时吊销） |
| 上游请求 | 全局 `fetch` / undici |
| 文档解析 | unpdf · mammoth · jszip |
| 部署 | 裸机（systemd / Windows 计划任务）或 Docker Compose |

前端与后端在同一 pnpm workspace 里，`server/` 是子包。

---

## 项目结构

```
.
├── src/                     # 前端（chat-demo 的 fork）
│   ├── app/ components/ i18n/ services/ utils/
│   ├── admin/               # 管理后台（第二入口）
│   └── about.ts             # 产品名、源码链接、许可（AGPL §13 履约入口）
├── server/                  # BFF
│   └── src/
│       ├── routes/          # chat / files / sessions / models / speech / ocr / admin
│       ├── caps/            # 能力实现：search / reader / ocr / documents / query / prefs / official
│       ├── pool/            # 渠道与 Key 选择、冷却、熔断
│       ├── protocol/        # DeepSeek 形状 ⇄ OpenAI 形状的流式翻译
│       ├── storage/         # 会话与附件（sha256 去重）
│       └── db/              # 手写 SQL 迁移 + 行类型
├── deploy/                  # systemd unit、Windows 计划任务脚本、SearXNG 配置
├── docs/                    # runbook / license / 架构说明
└── dist/                    # 前端构建产物（由 BFF 直接托管）
```

---

## 常用命令

```bash
# 前端
pnpm build          # 构建 dist/
pnpm dev            # 开发服务器（:8090，/api 代理到 :3000）
pnpm type           # 类型检查
pnpm lint           # oxlint
pnpm format         # oxfmt

# 后端
cd server
pnpm start          # 启动 BFF
pnpm dev            # 带 --watch
pnpm type           # 类型检查
pnpm smoke          # 轻量冒烟（健康检查 / 登录 / 模型 / 上传）
pnpm e2e            # 端到端闭环（自建 mock 上游，27 项断言）
```

---

## 部署

**裸机（推荐）**

```bash
# Linux
sudo cp deploy/systemd/ray.service /etc/systemd/system/ && sudo systemctl enable --now ray

# Windows
pwsh -File deploy\windows\install-task.ps1          # 登录自启
pwsh -File deploy\windows\install-task.ps1 -AtStartup   # 开机自启（管理员）
```

**Docker（可选）**

```bash
docker compose --env-file server/.env up -d --build
```

外网入口建议走 Cloudflare Tunnel，不要直接映射 3000 端口。详见 [docs/runbook.md](docs/runbook.md)。

---

## 许可与归属

本项目以 **AGPL-3.0** 发布。它是 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)
（MIT）的衍生作品，上游的版权与许可声明完整保留在 [LICENSE](./LICENSE) 末尾。

AGPL 第 13 条要求：通过网络使用本服务的用户有权获取完整源码。因此：

- 登录页首屏底部、设置 → 关于，都放了仓库链接
- 部署到别的地方时，请修改 `src/about.ts` 里的 `REPO_URL` 指向你自己的公开仓库

依赖审计结果（全部为 MIT / ISC / Apache-2.0 / BSD，无 GPL 传染）与义务清单见
[docs/license.md](docs/license.md)。

**本项目不是 DeepSeek 官方产品**，名称与界面不代表任何官方关联。
