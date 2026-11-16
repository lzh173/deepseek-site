import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { newRay } from '../lib/ray.ts'

/** 每个请求生成 ray，并写进响应头 x-ray-id。 */
export const requestIdPlugin = fp((app: FastifyInstance, _opts: unknown, done: () => void) => {
  app.decorateRequest('ray', '')
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (request, reply) => {
    request.ray = newRay()
    void reply.header('x-ray-id', request.ray)
  })
  done()
})
