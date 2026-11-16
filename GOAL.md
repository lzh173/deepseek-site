# GOAL.md — Ray：DeepSeek 风格的多渠道聊天服务

> 版本 v1.3 · 2026-11-16 · 状态：**已确认，可开工**
>
> v1.1 变更：① 明确仓库工作流（原 demo 只读参考）；② 付费白名单粒度改为**模型级**；③ `ray` 出现在**所有**错误信息中；④ 补充总体代码结构；⑤ 技术栈微调。
> v1.2 变更：① 路由与鉴权落到 **Key ⇄ 模型多对多**；② 公开模型不划分档位；③ 外层由 Cloudflare Access 承接；④ 可移植性列为硬要求；⑤ 工具链验证通过、构建脚本跨平台化。
> v1.3 变更：**白名单最终定为「Key × 模型」，两列均必填**；授权集合是故障转移的硬边界（越界即 403，集合内耗尽即 503）。
>
> 本文是唯一目标文档。实现以本文为准；与本文冲突的临时想法一律作废。

---

## 0. 一句话目标

以 `deepseek-ai/chat-demo` 为 UI 基座，把它的"浏览器直连 DeepSeek"改成"浏览器只连自建 BFF"，由 BFF 统一管理**付费渠道 / 免费渠道 / 加密 Key 池 / 能力兜底**，从而得到一个外观与官方网页端几乎一致、但可以用任意上游模型驱动、且所有服务端能力都有免费兜底实现的聊天站点。

---

## 1. 背景

- `chat-demo` 是**纯前端**项目：无服务端代码，构建产物是静态 `dist/`，API Key 存 localStorage，浏览器直连 `api.deepseek.com`。
- 该前端的"包装"（`src/services/api/*`）依赖 DeepSeek 私有协议：`/anthropic/v1/messages` 上的 Anthropic 兼容格式 + 私有扩展（`thinking`、`tools: deepseek_web_search / deepseek_read_url`、`safety_check`、`title`、`latest_reminder` 角色、`server_tool_use` / `web_search_tool_result` 块、AES-256-GCM 加密的 `encrypted_content`）。
- 因此**不能**简单把 `apiOrigin` 指向中转站。必须由 BFF 复刻这套协议形状，后端负责翻译与能力补齐。

---

## 2. 范围

### 2.1 做

1. Fork `chat-demo`，保持 UI 与交互一致，新增登录、模型选择、用量与降级提示。
2. 自建 BFF（Node + Fastify），实现前端的全部 API 需求。
3. 渠道管理：付费 / 免费两类，多个渠道，每个渠道下**多个 API Key 组成账号池**（加密存储、轮询、冷却、健康检查）。
4. 付费渠道严格按角色鉴权；管理员可按用户开白名单（粒度到 Key × 模型）。
5. 聊天记录与上传文件**存服务端**，带硬性限额。
6. 所有原本依赖上游的能力（标题、搜索、读链接、文档解析、多模态、语音、审核）都提供**免费兜底实现**或显式降级。
7. 管理后台（独立入口，风格与主站一致，支持暗色）。
8. 全部失败场景返回**服务器繁忙 + 请求编号 ray**。

### 2.2 不做

- 不做公开注册（账号由管理员创建）。
- 不做计费 / 充值 / 余额体系。
- 不复刻上游的"网页端账号 cookie 池"（无头浏览器刷免费额度），明确排除。
- 不做跨区域多活 / 分布式部署（单机 + SQLite 起步）。
- 不重写 Markdown / KaTeX / Mermaid / 分支 / 导入导出等 UI 能力，全部沿用。

### 2.3 仓库与工作流

| 角色 | 路径 / 远端 | 规则 |
|---|---|---|
| **项目仓库** | 本工作区 `E:\CODEX-NOworkspaces\deepseek-lzh`，`origin = git@github.com:lzh173/deepseek-site.git` | 所有开发都在这里，唯一可提交的仓库 |
| **上游** | `upstream = git@github.com:deepseek-ai/chat-demo.git` | 只 fetch，定期 `git merge upstream/main` 取官方更新 |
| **只读参考** | `deepseek-site/`（chat-demo 的独立克隆，`5d5dd75`） | **永不修改、永不提交**；已加入 `.gitignore`。用途：`diff -r` 对照官方实现、抄写未经改动的文件 |

当前基线：本仓库 HEAD 已 graft 到官方 `main@5d5dd75`（v0.1.1），历史为"官方两次提交 → 本文档"，可正常快进合并上游。

---


## 3. 已确认决策（用户拍板，不再讨论）

| 编号 | 决策 |
|---|---|
| D-01 | 界面风格与原 demo **完全一致**，包含亮色 / 暗色两种主题；管理后台沿用同一套设计令牌。 |
| D-02 | 账号池 = **API Key 池**：每个中转站 / 官方档可配多把 key，加密存储，轮询 + 冷却。**不是**网页端 cookie 池。 |
| D-03 | 管理员可以给**个别用户**开通付费白名单（粒度 = Key × 模型，见 §8）。 |
| D-04 | **所有免费 key 都失败**时，返回前端"服务器繁忙"+ **请求编号 `ray`**。 |
| D-05 | 付费渠道默认仅管理员可用；普通用户即使伪造请求也必须被服务端拒绝。 |
| D-06 | 聊天记录、上传文件存**服务端**，并设上限。 |
| D-07 | 前端对 DeepSeek 的直连包装**整体搬到后端**，协议形状保持不变（前端改动面最小）。 |
| D-08 | 当前依赖上游 API 的能力，**逐项都要有免费兜底实现**。 |

---

## 4. 默认采用（如无异议即按此实现）

| 编号 | 默认方案 | 说明 |
|---|---|---|
| A-01 | 账号由管理员在后台创建，无注册入口 | 与 D-01 一致，防滥用 |
| A-02 | 登录 = 用户名 + 密码，HttpOnly Cookie 会话 30 天滚动 | 管理端额外要求 CSRF 双提交 |
| A-03 | 首个管理员由环境变量 `RAY_ADMIN_USER` / `RAY_ADMIN_PASSWORD` 在首次启动时创建 | 不写死在代码里 |
| A-04 | 会话以服务端为**唯一真源**，前端 IndexedDB 仅做接口替换，不保留离线写 | 多端一致、删除即真删 |
| A-05 | 数据库 SQLite（WAL）+ better-sqlite3 + Drizzle | 单机足够，备份简单 |
| A-06 | 文件按 `sha256` 内容寻址落盘，重复上传只存一份 | 节省磁盘，天然去重 |
| A-07 | 搜索用自建 SearXNG；文档解析用纯 JS 库（不还原版面） | 免费、可控 |
| A-08 | 语音（ASR/TTS）MVP 直接走浏览器 Web Speech API，BFF 返回 501 | 零成本；后续可换本地 whisper |
| A-09 | 产品名暂定 **Ray**，代号同时作为请求编号前缀 | 正式名/域名待定，不阻塞 |
| A-10 | 单机 Docker Compose 部署（bff + caddy + searxng） | 后续可拆分 |
| A-11 | **外层由 Cloudflare Access 挡在前面**，应用内不做 IP 白名单 | HTTPS 由 Cloudflare 终止，BFF 本地可跑 http，不自行处理证书 |
| A-12 | 公开模型**不划分档位**，一个模型一条池子 | 质量波动由池内 Key 决定，接受 |
| A-13 | 会话与文件目录可通过 `RAY_DATA_DIR` 配置，默认 `./data` | 便于迁移与容器挂载 |

---

## 5. 系统架构

```
浏览器（fork 的 chat-demo）
   │  同源 /api，Cookie 会话，SSE
   ▼
┌──────────────── BFF · Fastify 5 · TypeScript ────────────────┐
│  plugins: auth / db / crypto / rate-limit / request-id        │
│                                                               │
│  routes/     chat · files · models · me · admin/*             │
│  protocol/   DeepSeek 形状 ⇄ OpenAI 形状（流式状态机）          │
│  pool/       渠道选择 · Key 轮询 · 冷却 · 配额 · 健康检查       │
│  caps/       title · search · reader · parse · vision          │
│              asr · tts · moderation                           │
│  storage/    sessions · files(sha256) · grants                 │
│  jobs/       孤儿文件清理 · 无引用附件过期 · 健康巡检            │
└───────────────┬───────────────────────────────┬───────────────┘
                │                               │
      渠道池（付费 / 免费）                 免费兜底服务
      └ 账号池（N 把 Key，AES-GCM）         SearXNG · RapidOCR(可选)
                │
        SQLite + data/files/
```

**分层原则**：`routes` 不认识上游协议；`protocol` 不认识渠道；`pool` 不认识 HTTP；`caps` 不认识会话。任何一层都能单独替换。

### 5.2 总体代码结构

```
deepseek-lzh/                      # 项目仓库（pnpm workspace）
├── GOAL.md                        # 本文档
├── pnpm-workspace.yaml            # packages: ["server"]
├── package.json                   # 前端（沿用 chat-demo 脚本）
├── rspack.config.ts               # 双入口：chat.html / admin.html
├── .gitignore                     # 含 deepseek-site/、data/、.env
│
├── src/                           # 前端 = fork 的 chat-demo
│   ├── app/ components/ i18n/ services/ utils/   # 保持原结构
│   └── admin/                     # ★新增：管理端（复用 base 组件与 theme.css）
│       ├── main.tsx
│       ├── AdminApp.tsx
│       ├── api.ts                 # 管理端 fetch 封装
│       ├── layout/                # 侧栏 / 顶栏 / 主题切换
│       ├── pages/                 # dashboard channels keys models grants users logs system
│       └── **/*.module.css
│
├── server/                        # ★新增：BFF
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts               # 启动、注册插件与路由
│       ├── env.ts                 # zod 校验的环境变量
│       ├── plugins/               # db / auth / crypto / rate-limit / request-id / errors
│       ├── routes/
│       │   ├── chat.ts            # POST /api/chat（SSE）
│       │   ├── files.ts           # POST/GET/DELETE /api/files
│       │   ├── models.ts          # GET /api/models（按角色过滤）
│       │   ├── me.ts              # 登录 / 登出 / 当前用户
│       │   ├── speech.ts          # MVP 501
│       │   └── admin/             # channels / keys / models / grants / users / logs / system
│       ├── protocol/              # DeepSeek 形状 ⇄ OpenAI 形状
│       │   ├── events.ts          # 事件状态机
│       │   ├── deepseek.ts        # 前端契约类型
│       │   └── openai.ts          # 上游流解析
│       ├── pool/                  # select / rotation / cooldown / health / quota
│       ├── caps/                  # title / search / reader / parse / vision / asr / tts / moderation
│       ├── storage/               # sessions / files(sha256) / grants
│       ├── db/                    # schema(drizzle) / migrate / seed
│       └── jobs/                  # cleaner（孤儿文件）/ healthcheck
│
├── data/                          # 运行期，gitignore
│   ├── ray.db
│   └── files/<sha256>
├── docs/                          # 设计、运维、API 说明
└── docker-compose.yml             # bff + caddy + searxng(+ocr)
```

**依赖边界**：前端只依赖 `src/services/api/*` 里的形状定义；后端只通过 `/api/*` 与前端通信；两端共享的类型放在 `server/src/protocol/deepseek.ts`，前端以 `import type` 引用（构建期擦除，不产生运行时耦合）。


---

## 6. 前端契约（BFF 必须原样满足）

### 6.1 端点映射

| 原调用 | 改为 | 请求 | 响应 |
|---|---|---|---|
| `GET {origin}/models` | `GET /api/models` | Cookie | `{ models: [...], ray }` |
| `POST /anthropic/v1/messages` | `POST /api/chat` | 原 body + `stream:true` | **DeepSeek 形状 SSE** |
| `POST /anthropic/v1/files` | `POST /api/files` | multipart，`purpose` 可选 | `FileObject` |
| `DELETE /anthropic/v1/files/{id}` | `DELETE /api/files/{id}` | — | 204 |
| ASR / TTS | `POST /api/speech/*` | — | MVP 返回 501，前端走浏览器 API |

鉴权：`Cookie: ray_session=...`；同时接受 `Authorization: Bearer <session token>` 便于 curl 调试。**不再接受 `x-api-key`。**

### 6.2 模型列表

```json
{
  "ray": "ray_9f2c1a7b4e60",
  "models": [{
    "id": "ray-chat",
    "display_name": "Ray Chat",
    "tier": "free",
    "available": true,
    "context": 32768,
    "caps": {
      "vision": true,
      "reasoning": true,
      "web_search": true,
      "read_url": true,
      "file_parse": true
    }
  }]
}
```

- 按角色 + 白名单过滤；普通用户看不到 `tier=paid` 的条目。
- 前端据此渲染模型下拉；`caps` 为 `false` 的能力对应开关要**隐藏**（不是置灰）。

### 6.3 流式事件

与 `src/services/api/types.ts` 完全一致：`message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`，**不发 `[DONE]`**，`event:` 名等于 JSON 的 `type`。

对上游的映射：

| 前端期望 | OpenAI 来源 | 处理 |
|---|---|---|
| `message_start` | 首个 chunk | 无 usage 时先发 0，末尾补 |
| `text_delta` | `delta.content` | 直通 |
| `thinking_delta` | `delta.reasoning_content` / `reasoning` | 映射；不支持则走 §9 的兜底 |
| `signature_delta` | 无 | 生成自己的 HMAC 令牌（内容可放续写上下文） |
| `citations_delta` | 无 | 由我们自己的检索结果合成，`cited_text` 取"截至该处的已输出正文" |
| `server_tool_use` / `web_search_tool_result` | 无 | 检索时构造；`encrypted_content` 填自己的 base64 索引，前端只当不透明串 |
| `message_delta.title` | 无 | 首轮结束后补发一条（本地启发式） |
| `message_stop` | `finish_reason` / `[DONE]` | 转换后结束，不转发 `[DONE]` |
| `latest_reminder` 角色 | 无 | 并入 system 或丢弃 |

### 6.4 错误文案必须匹配前端既有正则

前端 `errors.ts` 靠**英文文案正则**识别细分错误，BFF 必须照抄这些措辞，才能零改动拿到正确的本地化提示：

| 场景 | HTTP | message 必须包含 |
|---|---|---|
| 文件解析失败 | 400 | `Failed to recognize the file` |
| 单会话文件数超限 | 400 | `User file count limit exceeded ... limit 50` |
| 存储配额超限 | 400 | `User storage quota exceeded ... limit 20 GB` |
| file_id 不存在 | 400 | `file_ids do not exist or are not created under your account` |
| 单文件过大 | 413 | 任意（前端按状态码归类） |
| 服务繁忙 | 5xx | 见 §12 |
| 用户日配额耗尽 | 429 | 任意 |

> 其余场景返回通用 400 即可，前端会落到"操作失败"。

---

## 7. 渠道与账号池

### 7.1 数据模型

```sql
users(id, username, pass_hash, role['admin'|'user'], enabled,
      daily_quota, created_at)

channels(id, name, kind['openai'|'anthropic'|'gemini'|'ollama'],
         base_url, tier['paid'|'free'], priority, timeout_ms,
         concurrency, enabled, created_at)

keys(id, channel_id, key_cipher, label, group_label, weight,
     status['active'|'cooling'|'disabled'],
     cooldown_until, daily_quota, fail_count, last_ok_at, created_at)

-- ★ 路由的唯一依据：Key ⇄ 模型，多对多
key_models(key_id, upstream_model, public_model, weight, enabled)

key_usage(key_id, day, requests, tokens)        -- 复合主键，按天分桶

models(id, display_name, context, caps_json, tier,
       fallback_chain_json, enabled)

-- 付费白名单：粒度 =「Key × 模型」，两列均必填
grants(user_id, model_id, key_id, expires_at NULL)   -- PK(user_id, model_id, key_id)
auth_sessions(token_hash, user_id, expires_at, created_at)
user_prefs(user_id, key, value_json)

sessions(id, user_id, title, payload, created_at, updated_at)
files(sha256, size, mime, name, ref_count, created_at)
session_files(session_id, sha256)
usage_log(ray, ts, user_id, channel_id, key_id, public_model,
          upstream_model, in_tok, out_tok, ms, status, err)
```

**为什么是 `key_models` 而不是 `channel_models`**：同一个中转站里，不同分组的 Key 能调的模型集合不同（有的 Key 只买了 A 组，有的买了 B 组）；同一把 Key 也能同时覆盖多个模型。所以"渠道 → 模型"表达不了真实可达性，**必须落成 Key 与模型的多对多**。渠道只承载 `base_url` 与鉴权方式，模型可达性完全由 `key_models` 决定。

一个 `public_model` 只是一个名字，它背后可以是任意多条 `(key, upstream_model)` 记录；这就是"公开模型不分组、由池子兜底"的实现基础。

### 7.2 选择算法

```
输入：public_model P、用户 U

1. 授权判定（见 §8）：
     · free 模型 → 全员可用，key 集合 = 该模型下全部可用 key
     · admin     → 该模型下全部可用 key
     · 普通用户   → **仅 `grants` 中该 (user, model) 对应的 key 集合**
     · 无授权     → 403，且模型列表不返回该模型
2. 候选 = key_models 中 public_model = P 且 enabled，**且 key ∈ 第 1 步的 key 集合**
     · 同一 key 若有多条 upstream_model 指向 P，取 weight 最高的一条，按 key 去重
3. 过滤 key：
     key.status = 'active'
     key.cooldown_until < now
     今日 requests < key.daily_quota
     channel.enabled = true
4. 排序：used_today/daily_quota 升序（最闲优先）→ 同值按 channel.priority → 再按 weight 加权随机
5. 逐条尝试：
     成功    → requests+1, fail_count=0, last_ok_at=now
     429     → cooldown = min(60 × 2^fail_count, 3600)s，优先用 Retry-After
     401/403 → key.status='disabled'，后台红灯告警
     5xx/超时 → cooldown 30s，换下一条
6. 候选耗尽 → models[P].fallback_chain（仅在同一授权 key 集合内）→ 仍失败 → 503 server_busy
```

> 关键：**故障转移不跨越授权边界**。用户只被授权了 K2，K2 挂了就返回 503，不会偷偷换到 K5——否则"授权到 Key"就失去意义。



**硬约束**：只在**收到第一个正文 token 之前**允许无感换 Key。首 token 超时 8s，超时立即切换。已经向客户端输出过内容后，不再换模型，只结束流并提示中断。

### 7.3 Key 安全

- 落库前 `AES-256-GCM` 加密，主密钥 `RAY_MASTER_KEY` 只来自环境变量，绝不入库、绝不入 Git。
- 任何接口都不返回明文；列表只显示 `sk-••••a1b2`。
- 后台支持批量粘贴导入（一行一把）、单条启停、重置冷却、单 Key 连通性测试。

### 7.4 健康检查

- 被动为主：真实流量的失败率驱动冷却与禁用。
- 主动为辅：每 10 分钟对 `status != disabled` 的 Key 发一次轻量 `GET /models`，超时 5s。
- 渠道级熔断：5 分钟内失败率 > 50% → 整个渠道冷却 5 分钟。

---

## 8. 分级与白名单

### 8.1 授权模型

**授权的最小单元 = 「某把 Key 上的某个模型」。`model_id` 与 `key_id` 都是必填。**

```
grants(user_id, model_id, key_id, expires_at NULL)
PRIMARY KEY (user_id, model_id, key_id)
```

| 概念 | 含义 |
|---|---|
| 一条 grant | 允许 `user` 通过 `key` 调用 `model` |
| 同一 user + model 多条 grant | 允许走多把 Key，池子在这几把之间做负载均衡与故障转移 |
| 没有任何 grant | 该付费模型**不可见、不可用** |

为什么必须落到 Key：**模型可达性是 Key 级的**（见 §7.1）。同一把 Key 在不同分组下能调的模型不同，不同 Key 背后的成本与额度也不同。只在模型层授权，管理员就无法回答"这个人烧的是谁的额度"，也无法在 Key 失效时精确回收权限。

### 8.2 判定规则

| 场景 | 结果 | 模型列表 |
|---|---|---|
| `models.tier = free` | 可用，key 集合 = 该模型全部可用 Key | 显示 |
| `tier = paid` 且 `role = admin` | 可用，key 集合 = 该模型全部可用 Key | 显示 |
| `tier = paid` 且普通用户有有效 grant | 可用，**key 集合 = 该用户 grant 中的 Key ∩ 当前可用 Key** | 显示 |
| `tier = paid` 且普通用户无 grant | **403** | **不显示** |
| 有 grant，但授权 Key 全部不可用 | **503 `server_busy`**（不是 403） | 显示，标 `available: false` |
| `grants.expires_at` 已过 | 等同无 grant，TTL ≤ 30 s 内生效 | 不显示 |

- `GET /api/models`：按上表过滤，`available` 依授权 Key 的实时状态计算。
- `POST /api/chat`：**再校验一次**，只信服务端；伪造请求体命中未授权模型 → `403`。
- **403 与 503 的语义必须区分**：没权限是不给用；有权限但 Key 全挂是暂时没得用。前端对 503 显示"重试"，对 403 显示"无权限"。

### 8.3 与渠道的关系

- `channel.tier` 只决定**成本归属与统计口径**，不直接参与鉴权；鉴权只看 `grants`。
- 某个用户的模型可达性 = `grants` 授权的 Key 集合 ∩ 该模型在 `key_models` 中的 Key 集合 ∩ 当前可用 Key 集合。
- **公开模型不划分档位**：不做 fast/chat/pro 的层级，一个公开模型就是一条池子，池内任意 Key 可互相顶替——但**绝不允许跨出授权集合**。




---

## 9. 能力兜底矩阵

| # | 能力 | 上游实现 | 免费兜底 | 降级表现 |
|---|---|---|---|---|
| 1 | 对话 | 付费/免费渠道 | 免费 Key 池 → 本地 Ollama | 质量下降 |
| 2 | 深度思考 | `reasoning_content` | ①原生映射 ②二段式"先析后答"模拟（标 `simulated`）③`none` 则隐藏开关 | 模拟耗 2 倍 token |
| 3 | 自动标题 | `message_delta.title` | **纯本地启发式**（首句/前 20 字，去 Markdown） | 标题略糙，零成本 |
| 4 | 联网搜索 | `deepseek_web_search` | SearXNG → DDG 抓取 → `unavailable` | 结果质量下降 |
| 5 | 读链接 | `deepseek_read_url` | undici + Readability；失败回 `url_not_accessible` | SPA 页失败 |
| 6 | 文档解析 | `rich_layout_recognition` | `unpdf` / `mammoth` / pptx 库；无文本层转 OCR | 表格与排版丢失 |
| 7 | 图片理解 | 多模态模型 | 免费 VLM → RapidOCR 提字 → VLM 转述 | 图表细节丢失 |
| 8 | 语音转写 | 上游 ASR | 浏览器 Web Speech（MVP）→ whisper.cpp | 需前端支持 |
| 9 | 朗读 | 上游 TTS | 浏览器 `speechSynthesis`（MVP 默认） | 音色单一 |
| 10 | 内容审核 | `safety_check` | 本地关键词/正则 + 可选小模型 | 覆盖不全 |

**三条铁律**

1. **兜底必须显式**：任何降级都要在消息上打标（如「经 OCR 提取」「由 SearXNG 检索」），不允许让用户误以为模型真的看见了图。
2. **失败必须说话**：宁可返回标准错误码，也不许静默编造内容。
3. **搜索/解析失败不能拖垮对话**：检索挂了就退化成普通对话，并在来源面板显示"检索不可用"。

---

## 10. 多模态降级

```
用户发送带图消息
  ├─ 模型 caps.vision = true
  │     └─ 原图直传（前端压缩至 ≤1024px / ≤1MB）
  └─ caps.vision = false
        └─ 弹窗三选一（可勾选「以后都这样」）
             ├─ ① 换一个能看图的模型（列出可用 vision 模型）
             ├─ ② OCR 只发文字（RapidOCR；纯文字截图效果好）
             └─ ③ 让 vision 模型「看图说话」，再把描述交给目标模型
```

- ③ 的产物必须在气泡上加徽标：`已由 <模型> 转述`。
- ①②③ 全不可用时，明确告知"这张图我看不了，请换模型"，**不得**把图片描述成文字后假装看过。
- 选择结果记入用户偏好（服务端 `user_prefs`），下次同模型自动复用。

---

## 11. 存储与限额

### 11.1 默认限额（服务端强制，前端数值可放宽但不生效）

| 项 | 默认值 | 超限行为 |
|---|---|---|
| 单文件（文档） | 64 MB | 413 → 前端「文件过大」 |
| 单文件（文本/代码/表格） | 32 MB | 413 |
| 单文件（图片） | 20 MB | 413 |
| 单条消息附件数 | 50 | 400 + 匹配正则 |
| 单用户总磁盘 | 20 GB | 400 + 匹配正则 |
| 单用户日上传量 | 1 GB | 429 |
| 单用户日请求数（免费） | 500 | 429 |
| 请求体上限 | 35 MB | 413 |
| 会话列表返回 | 最多 2000 条摘要 | 超出只返回最近 2000 |
| 无引用附件保留 | 7 天 | 定时清理 |
| 会话删除 | 立即减引用，归零即删文件 | — |

### 11.2 写入策略

- 会话以整棵 `Session` JSON 存 `sessions.payload`，与前端 IndexedDB schema 一一对应，迁移成本最低。
- **流式期间不写库**：`message_delta` 每 1~2 秒 debounce 一次 `PATCH`，`message_stop` 时终态写一次。避免一条长回复产生上百次请求。
- 文件上传"选中即上传"（沿用前端行为），因此必须处理**孤儿文件**：`ref_count = 0` 且创建超过 24h 的文件由定时任务清理。

---

## 12. 错误与 ray

### 12.1 ray 规则

- 每个 HTTP 请求生成一个 `ray`：`ray_` + 12 位十六进制。
- 响应头 `x-ray-id` **恒返回**（成功与失败都有）。
- **所有**错误响应体都带 `ray` 字段，且 `error.message` 末尾统一追加 `（请求编号：<ray>）`——不区分状态码，401/403/404/413/429/500/503 一律如此。
- 流式响应开始后出错时，错误帧同样携带 ray。
- 写入 `usage_log`，后台可按 ray 精确检索。


### 12.2 错误体

```json
{ "ray": "ray_9f2c1a7b4e60",
  "error": { "type": "server_busy",
             "message": "服务器繁忙，请稍后再试（请求编号：ray_9f2c1a7b4e60）" } }
```

前端只读 `error.message`，所以 **ray 必须拼进 message**，这样无需改前端就能显示。状态码 5xx 会命中前端 `classifyStatus → serverBusy`，自动出现"重试"。

### 12.3 状态码约定

| 情况 | 状态码 | type |
|---|---|---|
| 未登录 | 401 | `unauthorized` |
| 无权限用付费模型 | 403 | `forbidden` |
| 请求体非法 | 400 | `invalid_request` |
| 用户日配额耗尽 | 429 | `user_quota_exceeded` |
| 上游全渠道限流 | 429 | `rate_limited` |
| **所有免费 Key 均不可用** | **503** | **`server_busy`** |
| 上游全挂（付费也失败） | 503 | `upstream_unavailable` |
| 服务内部错误 | 500 | `internal` |

**流已开始后出错**：发一帧 `data: {"error":{"message":"..."}}` 后关闭连接；前端显示为"输出中断"。

---

## 13. UI 规范

- **完全沿用** `src/app/theme.css` 的设计令牌与 `data-theme` 机制，亮/暗两套主题必须同步支持；不许出现硬编码颜色。
- 复用 `src/components/base/*`：Button / IconButton / Menu / Modal / Select / Toast / Tooltip / anchored / icons。
- 复用 CSS Modules，**不引入** Tailwind、antd、shadcn、路由库。
- 新增页面沿用同一间距 / 圆角 / 字号 / 过渡节奏；只允许新增，不改动既有视觉。
- 图标优先从 `components/base/icons.tsx` 取，不新增图标库。
- 所有新增文案走 `src/i18n/{zh,en}.ts` 键值，不写死中文。

**前端改动面（预估）**

| 文件 | 改动 |
|---|---|
| `src/services/chat/db.ts` | IndexedDB → HTTP，导出签名不变 |
| `src/services/api/client.ts` | `API_ORIGIN` → 同源；`x-api-key` → Cookie |
| `src/services/attachments.ts` | 上传目标改 BFF，保留 64/32/50/3 常量 |
| `src/services/settings.ts` | 移除 API Key，改为会话与模型偏好 |
| `src/components/settings/*` | 登录/退出、模型下拉、能力位驱动的开关显隐 |
| `src/types`（`api/types.ts`） | `ChatModel` 由联合类型改为 `string` |
| `rspack.config.ts` | devServer 代理指向 BFF + 第二入口 `admin.html` |
| `src/i18n/{zh,en}.ts` | 新增登录、限额、降级、繁忙等键 |

协议层（`client.ts` 的请求形状、SSE 解析）**不动**。

---

## 14. 管理后台

独立入口 `src/admin/`（同仓、第二个 rspack entry），复用 `components/base` 与 `theme.css`，支持暗色。

| 页面 | 内容 |
|---|---|
| 仪表盘 | 今日请求/失败率/token、渠道健康灯、Key 池余量条、最近错误 |
| 渠道 | 增删改、连通性测试、优先级、超时、并发、启停、付费/免费切换 |
| 账号池 | 批量导入、掩码显示、状态、权重、今日用量、冷却倒计时、单 Key 测试 |
| 模型 | 公开名、能力位、context、tier、回退链；**Key ⇄ 上游模型映射矩阵**（哪把 Key 能调哪些模型） |
| 用户 | 角色、日配额、重置密码、**付费白名单（模型 × Key 勾选 + 有效期）** |
| 日志 | 按 ray / 用户 / 模型 / 渠道 / 状态筛选 |
| 系统 | 磁盘用量、孤儿文件清理、备份导出 |

---

## 15. 安全

| 项 | 要求 |
|---|---|
| Key 加密 | AES-256-GCM，主密钥仅环境变量；接口一律掩码 |
| 会话 | HttpOnly + Secure + SameSite=Lax；管理端 CSRF 双提交 |
| SSRF（读链接） | DNS 解析后校验；禁私网/环回/链路本地/`169.254.169.254`；≤3 次跳转、≤5 MB、≤15 s |
| 上传 | magic bytes 校验真实类型 + 扩展名白名单；存储目录不可执行；下载带 `Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff` |
| 提示词注入 | 抓取的网页正文用分隔符包裹并标注"以下为不可信数据"；剥离形似工具调用的文本 |
| 限流 | 用户级 + IP 级；登录失败 5 次锁 15 分钟 |
| 审计 | 管理端所有写操作记 `usage_log` 或独立审计表 |

---

## 16. 非功能需求

- 首 token P50 < 3 s（付费渠道），免费渠道 < 6 s。
- 单实例支撑 50 并发 SSE 长连接。
- 崩溃后可恢复：SQLite WAL + 文件按 sha256 存放，无中间状态损坏。
- 备份：`sqlite3 .backup` + `rsync data/files`，每日定时。
- 日志结构化（pino），携带 ray，可直接 grep。

### 16.1 可移植性与可部署性（硬要求）

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 开发、Linux 部署，**同一套脚本两边都能跑**；不允许出现只有 POSIX 才能执行的 `package.json` 脚本 |
| Node | `>= 22.12`，用 `.node-version` 固定；本机实测 v24.19.0 |
| pnpm | 通过 corepack 管理，`packageManager` 字段固定版本；本机实测 12.21.0 |
| 依赖目录 | pnpm store / cache 属于**机器本地配置**，绝不写进仓库；每台机器自行 `pnpm config set store-dir <非系统盘>` |
| 路径 | 代码中禁止硬编码盘符；数据目录、端口、密钥全部来自环境变量 |
| 配置 | `.env.example` 提供全部键位与默认值；`.env` 不入库 |
| 部署 | Docker Compose 为第一形态，裸机运行为第二形态；两者共用同一份环境变量 |
| 数据库 | SQLite 单文件，可直接复制迁移；不使用任何本地安装的数据库服务 |
| 时间 | 一律 UTC 存储，展示按用户时区 |

### 16.2 工具链验证结果（2026-11-16，本机）

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `pnpm install` | 235 包，20.6 s，store 在 `E:\.pnpm-store` |
| 生产构建 | `pnpm build` | 成功，745 ms，`dist` 4.29 MB，JS 已压缩无 sourcemap |
| 开发服务 | `pnpm dev` | 成功，8090 端口，591 ms |
| 类型检查 | `pnpm type` | 通过 |
| Lint | `pnpm lint` | 0 warning / 0 error（118 文件） |

> 构建脚本已改为跨平台：`"build": "rspack build -c rspack.config.ts"`，模式由 `rspack.config.ts` 依据 `serve`/`build` 子命令判定，不再依赖 `NODE_ENV=production` 前缀（Windows cmd 不支持）。`dist` 清理由 `output.clean: true` 负责。

---

## 17. 里程碑与验收

### M0 · 工具链验证 ✅ 已完成（2026-11-16）
`pnpm install` / `pnpm build` / `pnpm dev` / `pnpm type` / `pnpm lint` 全部通过，构建脚本已改为跨平台。

### M1 · 骨架（8–10 人日）
Fastify + 登录 + SQLite + 协议翻译 + 单渠道 + 会话/文件存储。

**验收**
- [ ] 原 demo 全部 UI 功能在 BFF 下可用（除语音、搜索）
- [ ] 刷新页面后会话与附件仍在
- [ ] 断网后前端显示网络错误，不是白屏

### M2 · 渠道与账号池（8–10 人日）
渠道 CRUD、Key 池、轮询冷却、健康检查、付费分级、白名单、管理端前 4 页。

**验收**
- [ ] 一个渠道录入 3 把 Key，禁用其中 2 把后请求仍成功
- [ ] 把某 Key 的响应改成 429，该 Key 进入冷却且不被打到
- [ ] 普通用户请求付费模型 → 403；列表里也看不到
- [ ] 授权 `ray-pro × K2` 后，只有该模型出现，其他付费模型仍不可见
- [ ] 同一模型再授权 K5，请求在 K2/K5 之间轮转，绝不落到未授权的 K7
- [ ] 把 K2、K5 全部禁用 → 返回 503（不是 403，也不偷偷换 Key）
- [ ] 授权到期后 30 s 内失效，再请求返回 403
- [ ] 401/403/429/500/503 任意错误的 message 都含 ray，且该 ray 可在后台日志中查到
- [ ] 后台 Key 列表只显示掩码

### M3 · 免费兜底（8–10 人日）
title / search / reader / parse / asr / tts / moderation 全部落地。

**验收**
- [ ] 关闭 SearXNG，对话仍可用，来源面板显示"检索不可用"
- [ ] 上传扫描版 PDF，自动转 OCR 并给出可读文本
- [ ] 标题在 200 ms 内生成，不产生任何上游调用
- [ ] 读链接访问 `http://127.0.0.1` 被拒

### M4 · 打磨（6–8 人日）
多模态降级链路、日志看板、备份、部署、压测。

**验收**
- [ ] 所有免费 Key 置为 disabled → 前端显示"服务器繁忙（请求编号：ray_xxx）"，且该 ray 能在后台日志中查到
- [ ] 暗色模式全站无闪白、无硬编码颜色
- [ ] 删除会话后磁盘占用确实下降
- [ ] 同一文件上传两次只占一份空间

---

## 18. 风险

| 风险 | 等级 | 对策 |
|---|---|---|
| 账号池批量封禁 | 高 | 分池、日配额封顶、优先官方免费档、失败即熔断 |
| Key 泄露 | 高 | AES-GCM + 掩码 + 主密钥不入库不入 Git |
| SSRF | 高 | 见 §15 |
| 免费额度被刷爆 | 高 | 无注册 + 每用户日限 + 并发限 + 首 token 超时 |
| 降级不可见 | 中 | 强制打标 |
| 合规与商标 | 中 | 改名换皮、备案、保留 LICENSE、不暗示官方关联 |

---

## 19. 待定（不阻塞开工）

| 项 | 说明 |
|---|---|
| 正式产品名 / 域名 | 暂用 **Ray** |
| 部署地区（境内/境外） | 影响备案与可选上游；架构不感知 |
| 是否开放注册 | 默认不开放 |
| 语音是否升级为本地 whisper | M4 后视使用情况 |

---

## 附 A：外部依赖清单

**前端**（沿用 chat-demo，不新增运行时依赖）
`react 18.3` · `rspack 2` · `zustand 4` · `typescript 7` · `idb` · `fflate` · `katex` · `mermaid` · `prismjs`

**后端**
`fastify 5` · `@fastify/cookie` · `@fastify/multipart` · `@fastify/rate-limit` · `@fastify/helmet` · `@fastify/static`
`better-sqlite3` · `drizzle-orm` · `zod` · `undici` · `pino` · `@node-rs/argon2`
`unpdf` · `mammoth` · `@mozilla/readability` · `jsdom`

**旁挂服务**
`searxng`（搜索）· 可选 `rapidocr`（OCR）· 可选 `whisper.cpp`（ASR）

### 技术栈 v1.1 调整点

| 项 | 调整 | 原因 |
|---|---|---|
| 密码哈希 | 明确用 `@node-rs/argon2`（默认参数） | 比 bcrypt 更现代，内存硬 |
| 会话 | **不用 JWT**，改为 `auth_sessions` 表存 token 哈希 | 可即时吊销、可看登录设备 |
| 鉴权粒度 | `grants` 到 `model_id` | 见 §8 |
| 包管理 | pnpm workspace，`server/` 为子包 | 一条 `pnpm install` 装完两端 |
| 构建入口 | rspack 双入口 `chat.html` + `admin.html` | 管理端独立加载，不拖慢聊天页 |
| 错误处理 | 统一 `errors` 插件，强制注入 ray | 见 §12.1 |
| 前端依赖 | **不新增任何运行时依赖** | 保持与 demo 一致的构建体积与环境 |

---

