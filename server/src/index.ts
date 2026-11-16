import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from './db/index.ts'
import { seedAdmin } from './db/seed.ts'
import { env } from './env.ts'
import { authPlugin } from './plugins/auth.ts'
import { dbPlugin } from './plugins/db.ts'
import { errorPlugin } from './plugins/errors.ts'
import { requestIdPlugin } from './plugins/requestId.ts'
import { adminRoutes } from './routes/admin/index.ts'
import { authRoutes } from './routes/auth.ts'
import { chatRoutes } from './routes/chat.ts'
import { fileRoutes } from './routes/files.ts'
import { healthRoutes } from './routes/health.ts'
import { modelRoutes } from './routes/models.ts'
import { sessionRoutes } from './routes/sessions.ts'

export const buildApp = async (): Promise<FastifyInstance> => {
  const db = openDb()
  await seedAdmin(db)

  const app = Fastify({
    logger: { level: env.RAY_LOG_LEVEL },
    bodyLimit: 35 * 1024 * 1024,
    trustProxy: true,
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cookie)

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
      await api.register(healthRoutes)
      await api.register(authRoutes)
      await api.register(modelRoutes)
      await api.register(chatRoutes)
      await api.register(fileRoutes)
      await api.register(sessionRoutes)
      await api.register(adminRoutes, { prefix: '/admin' })
    },
    { prefix: '/api' }
  )

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
  app.log.info(`[ray] listening on http://${env.RAY_HOST}:${env.RAY_PORT}`)
}
