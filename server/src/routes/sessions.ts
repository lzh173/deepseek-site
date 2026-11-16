import type { FastifyInstance } from 'fastify'
import { HttpError } from '../lib/errors.ts'
import { requireUser } from '../plugins/auth.ts'

/** TODO(子代理 C)：会话 CRUD，payload 为整棵 Session 树 JSON。 */
export const sessionRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/sessions', { preHandler: requireUser }, async () => {
    throw new HttpError(501, 'internal', '会话接口尚未接通')
  })
}
