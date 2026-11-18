import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from './db/index.ts'
import { seedAdmin, seedUpstream } from './db/seed.ts'
import { syncOfficialChannels } from './db/official.ts'
import { env } from './env.ts'
import { startJobs } from './jobs/index.ts'
import { authPlugin } from './plugins/auth.ts'
import { dbPlugin } from './plugins/db.ts'
import { errorPlugin } from './plugins/errors.ts'
import { requestIdPlugin } from './plugins/requestId.ts'
import { adminRoutes } from './routes/admin/index.ts'
import { warmupSearch } from './caps/search.ts'
import { authRoutes } from './routes/auth.ts'
import { chatRoutes } from './routes/chat.ts'
import { fileRoutes } from './routes/files.ts'
import { healthRoutes } from './routes/health.ts'
import { modelRoutes } from './routes/models.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { speechRoutes } from './routes/speech.ts'
import { capabilityRoutes } from './routes/capabilities.ts'
import { visionRoutes } from './routes/vision.ts'

export const buildApp = async (): Promise<FastifyInstance> => {
  const db = openDb()
  await seedAdmin(db)
  seedUpstream(db)
  syncOfficialChannels(db)

  const app = Fastify({
    logger: { level: env.RAY_LOG_LEVEL },
    bodyLimit: 35 * 1024 * 1024,
    trustProxy: true,
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cookie)

  // 容忍「声明了 application/json 但 body 为空」的请求（如 POST /keys/:id/reset）：
  // Fastify 默认会直接 400，很多前端封装会顺手带上这个头。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch (error) {
      done(error as Error, undefined)
    }
  })

  /**
   * 兜底解析器：浏览器用 fetch 发「没有 body 的 POST」时**不会带 Content-Type**，
   * 而 Fastify 对 POST 遇到无法识别的 Content-Type 会直接 415。
   * 退出登录（POST /api/auth/logout，无 body）因此在浏览器里永远失败——
   * 前端收到 415 抛错，登录态清不掉。
   *
   * 这里把「未知类型」统一按文本读出来：空的当 {}，能当 JSON 解析的就解析，
   * 其余原样丢弃。multipart/form-data 有自己更精确的解析器，不受影响。
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch {
      done(null, {})
    }
  })

  await app.register(dbPlugin, { db })
  await app.register(requestIdPlugin)
  await app.register(errorPlugin)
  await app.register(authPlugin)

  // multipart 与文件模块一起注册，路由层自己决定字段
  await app.register(multipart, {
    limits: { fileSize: env.RAY_MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  })

  await app.register(
    async (api) => {
      // 只对 /api 限流，静态资源（一个页面几十个 chunk）不受影响
      await api.register(rateLimit, {
        max: 300,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.ip,
      })

      await api.register(healthRoutes)
      await api.register(authRoutes)
      await api.register(modelRoutes)
      await api.register(chatRoutes)
      await api.register(fileRoutes)
      await api.register(sessionRoutes)
      await api.register(visionRoutes)
      await api.register(speechRoutes)
      await api.register(capabilityRoutes)
      await api.register(adminRoutes, { prefix: '/admin' })
    },
    { prefix: '/api' }
  )

  startJobs(app)

  // 预热搜索兜底连接（冷启动首次 TLS 握手可能超过搜索预算，会拖慢第一条带搜索的消息）
  warmupSearch()

  // 可选：把前端构建产物（dist）一起托管，便于单容器部署。
  // 未配置 RAY_WEB_DIR 或目录不存在时跳过，静态资源交给前置的 Caddy / Cloudflare。
  const webDir = env.RAY_WEB_DIR ? path.resolve(env.RAY_WEB_DIR) : ''
  if (webDir && fs.existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      index: ['index.html'],
      // 关键：必须允许通配。前端产物带内容哈希（main.f9cfaa78.js），
      // wildcard: false 会在启动时把文件列表固化下来，
      // 之后重新 pnpm build 出的新文件名会直接 404，只能重启 BFF 才能恢复。
      wildcard: true,
      // 就地重新构建时不要被 304 卡住：文件 mtime 变了才走缓存
      cacheControl: true,
      maxAge: 0,
      // ETag 交给浏览器协商缓存；哈希文件名本身已经保证了缓存安全
      etag: true,
      lastModified: true,
    })
    app.log.info(`[zhds] serving static site from ${webDir}`)
  }

  return app
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/src/index.ts')

if (isMain) {
  const app = await buildApp()
  const close = async (): Promise<void> => {
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void close())
  process.on('SIGTERM', () => void close())
  await app.listen({ port: env.RAY_PORT, host: env.RAY_HOST })
  app.log.info(`[zhds] listening on http://${env.RAY_HOST}:${env.RAY_PORT}`)
}
