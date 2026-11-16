import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../../plugins/auth.ts'
import { channelRoutes } from './channels.ts'
import { keyRoutes } from './keys.ts'
import { logRoutes } from './logs.ts'
import { modelAdminRoutes } from './models.ts'
import { systemRoutes } from './system.ts'
import { userAdminRoutes } from './users.ts'

/**
 * 管理端路由统一挂在 /api/admin 下（由 index.ts 的 register 前缀决定），全部要求 admin。
 *
 * 钩子先加、子路由后注册：preHandler 对同一封装上下文内随后注册的路由生效，
 * 所以这里不需要在每个子文件里各写一遍 requireAdmin。
 */
export const adminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAdmin)

  await app.register(channelRoutes)
  await app.register(keyRoutes)
  await app.register(modelAdminRoutes)
  await app.register(userAdminRoutes)
  await app.register(logRoutes)
  await app.register(systemRoutes)
}
