import type { FastifyInstance } from 'fastify'
import { nowIso } from '../lib/time.ts'

export const healthRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/health', async (request) => ({
    ok: true,
    ray: request.ray,
    time: nowIso(),
    uptime: Math.round(process.uptime()),
  }))
}
