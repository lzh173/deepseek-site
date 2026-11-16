import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../../plugins/auth.ts'

/**
 * 管理端路由统一挂在 /api/admin 下，全部要求 admin 角色。
 * TODO(子代理 A)：channels / keys / models / users(grants) / logs / system
 */
export const adminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAdmin)
}
