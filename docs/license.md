# 许可与开源合规说明

> 本文说明本项目的许可选择、可行性依据，以及对外分发时必须履行的义务。

## 1. 结论

| 项 | 结论 |
|---|---|
| 当前许可 | **AGPL-3.0-only** |
| 是否可行 | ✅ 可行，无法律或依赖层面的阻碍 |
| 上游许可 | chat-demo 为 **MIT**，允许再许可为更严格的许可 |
| 依赖许可 | 全部为宽松许可（MIT / ISC / Apache-2.0 / BSD），**无 GPL/AGPL 传染** |
| 主要义务 | 通过网络提供服务时，必须向用户提供完整源码 |

## 2. 为什么从 MIT 换成 AGPL 是合法的

上游 `deepseek-ai/chat-demo` 使用 MIT 许可。MIT 的授权条款允许：

> to deal in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense...

其中 **sublicense（再许可）** 是关键：MIT 允许下游以不同（包括更严格）的条款分发衍生作品，
唯一硬性要求是**保留原版权声明与许可声明**。

因此我们的做法是：

1. `LICENSE` 文件正文为 AGPL-3.0，末尾附上上游 MIT 全文与版权声明；
2. 项目自身版权归 "ZH DeepSeek contributors"；
3. 上游归属在 README / 本文件中明确标注。

这满足 MIT 的署名义务，同时让整个衍生作品落在 AGPL 之下。

## 3. 依赖许可审计结果

用 `pnpm licenses list --prod --json` 实测（2026-11-18）：

**前端生产依赖**

| 许可 | 数量 |
|---|---|
| MIT | 162 |
| ISC | 33 |
| Apache-2.0 | 6 |
| BSD-3-Clause | 6 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| Unlicense | 1 |

**后端生产依赖**

| 许可 | 数量 |
|---|---|
| MIT | 85 |
| ISC | 9 |
| BlueOak-1.0.0 | 8 |
| BSD-2-Clause | 4 |
| BSD-3-Clause | 4 |
| BSD | 1 |
| (MIT OR GPL-3.0-or-later) | 1（`jszip`，选 MIT 分支） |
| (MIT AND Zlib) | 1 |

关键结论：**没有任何 GPL / AGPL / SSPL 依赖**。AGPL 与 MIT、ISC、Apache-2.0、BSD 均兼容
（AGPL 更严格，可以把宽松许可的代码吸收进来，反之不行）。

`jszip` 是双许可 `MIT OR GPL-3.0-or-later`，我们按 MIT 使用，不触发 GPL 义务。

## 4. AGPL 带来的实际义务

AGPL-3.0 相对 MIT 多了**第 13 条（Remote Network Interaction）**：

> 如果修改后的程序通过网络与用户交互，必须向这些用户提供获取完整对应源码的机会。

对本项目的具体含义：

| 场景 | 是否需要提供源码 |
|---|---|
| 自己本地跑，不对外开放 | 不需要 |
| 部署给自己和少数人用，但不分发 | **需要**（只要能通过网络访问，就要提供源码） |
| 对外提供服务 | 需要，且必须让用户能找到源码入口 |
| 只分发二进制/容器镜像 | 需要附带源码或书面提供源码的承诺 |

实践建议：

- 在站点页脚或「关于」里放一个 **源码链接**（指向本仓库），最省事；
- 若对外分发 Docker 镜像，同时提供构建所需的完整源码；
- 修改了代码但没公开部署，则没有分发行为，不触发义务（但一旦部署给他人用就触发）。

## 5. 商标与命名

- 许可只涉及**代码**，不涉及商标。
- 本项目**不是** DeepSeek 官方产品，命名与界面中不得暗示官方关联；
- 上游 chat-demo 的 MIT 许可同样不授予 DeepSeek 商标使用权；
- 当前产品名为 **ZH DeepSeek**，如需对外发布，建议再确认一次名称可用性。

## 6. 第三方服务的许可无关性

DeepSeek API、OpenRouter、SearXNG、各中转站属于**服务**而非本项目分发的代码，
它们各自的**服务条款**独立于本项目的开源许可：

- 用官方 API：遵守 DeepSeek 的服务条款与计费规则；
- 用中转站：遵守对应站点的条款（转售/共享 Key 可能违反其 ToS）；
- 自建 SearXNG：SearXNG 自身是 AGPL-3.0，与本项目许可相容。

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-17 | 项目初始化为 MIT（沿用上游） |
| 2026-11-18 | 整体改为 AGPL-3.0-only，保留上游 MIT 声明；产品更名 ZH DeepSeek |
