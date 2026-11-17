import path from 'node:path'
import { z } from 'zod'

const EnvSchema = z.object({
  RAY_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RAY_HOST: z.string().min(1).default('127.0.0.1'),
  RAY_DATA_DIR: z.string().min(1).default('./data'),
  RAY_DB_PATH: z.string().min(1).optional(),
  /** 32 字节 hex 或任意口令；缺省时自动生成并落盘到 <data>/.master-key */
  RAY_MASTER_KEY: z.string().min(1).optional(),
  RAY_ADMIN_USER: z.string().min(1).default('admin'),
  RAY_ADMIN_PASSWORD: z.string().min(6).optional(),
  RAY_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  RAY_COOKIE_NAME: z.string().min(1).default('ray_session'),
  /** 走 Cloudflare 时设为 true；本地 http 调试保持 false */
  RAY_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  RAY_SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RAY_MAX_UPLOAD_MB: z.coerce.number().int().min(1).default(64),
  RAY_USER_DAILY_QUOTA: z.coerce.number().int().min(0).default(500),
  /** 单上游快捷配置：渠道表还没有数据时用它兜底，方便 M1 冒烟 */
  RAY_UPSTREAM_BASE_URL: z.string().url().optional(),
  RAY_UPSTREAM_API_KEY: z.string().min(1).optional(),
  RAY_UPSTREAM_MODEL: z.string().min(1).optional(),
  /** 可选的静态站点目录；存在时由 BFF 直接托管前端产物（dist） */
  RAY_WEB_DIR: z.string().optional(),
  /** SearXNG 实例地址，例如 http://127.0.0.1:8080；未配置时联网搜索走兜底抓取 */
  RAY_SEARXNG_URL: z.string().url().optional(),
  /** 读链接允许的最大正文字节数 */
  RAY_READ_MAX_BYTES: z.coerce.number().int().min(1024).default(2_000_000),
  /** 本地关键词审核清单，英文逗号分隔；为空表示不拦截 */
  RAY_MODERATION_KEYWORDS: z.string().optional(),
  /**
   * 首 token 超时（毫秒）。免费中转站排队时间差异很大，默认给 15 秒；
   * 超时即认为当前 Key 不可用，会换下一把重试。
   */
  RAY_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),
  /** DeepSeek 官方渠道的 BASE URL；OpenAI 兼容接口不带 /v1，默认即可 */
  RAY_OFFICIAL_BASE_URL: z.string().url().optional(),
  /**
   * 官方工具类能力（search / fetch / tts / asr / ocr / 文档解析）的开放范围。
   * 取值：admin | authorized | all，逗号分隔。默认「管理员 + 被授权账号」。
   */
  RAY_OFFICIAL_TOOLS_FOR: z.string().default('admin,authorized'),
  /** 设为 "0" 可整体关闭官方工具能力，全部回退到免费实现 */
  RAY_OFFICIAL_TOOLS: z.enum(['0', '1']).default('1'),
})

export type Env = z.infer<typeof EnvSchema> & {
  dataDir: string
  dbPath: string
}

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`环境变量校验失败：\n${issues}`)
  process.exit(1)
}

const dataDir = path.resolve(parsed.data.RAY_DATA_DIR)

export const env: Env = {
  ...parsed.data,
  dataDir,
  dbPath: parsed.data.RAY_DB_PATH ? path.resolve(parsed.data.RAY_DB_PATH) : path.join(dataDir, 'ray.db'),
}
