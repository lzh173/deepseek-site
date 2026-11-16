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
