import type { FastifyInstance } from 'fastify'
import { HttpError } from '../lib/errors.ts'
import { requireUser } from '../plugins/auth.ts'

/** TODO(子代理 C)：上传 / 下载 / 删除，按 sha256 去重并维护 ref_count。 */
export const fileRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/files', { preHandler: requireUser }, async () => {
    throw new HttpError(501, 'internal', '文件上传尚未接通')
  })
}
