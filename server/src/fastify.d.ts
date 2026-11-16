import type { Db } from './db/index.ts'
import type { SessionUser } from './lib/user.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** 每个请求一个，形如 ray_9f2c1a7b4e60 */
    ray: string
    /** 登录用户，未登录为 null */
    user: SessionUser | null
  }

  interface FastifyInstance {
    db: Db
  }
}
