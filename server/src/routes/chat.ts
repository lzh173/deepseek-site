import type { FastifyInstance } from 'fastify'
import { HttpError } from '../lib/errors.ts'
import { requireUser } from '../plugins/auth.ts'

/** TODO(子代理 B)：把 OpenAI 流翻译成 DeepSeek 形状的 SSE。见 GOAL.md §6.3。 */
export const chatRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/chat', { preHandler: requireUser }, async () => {
    throw new HttpError(501, 'internal', '对话接口尚未接通')
  })
}
