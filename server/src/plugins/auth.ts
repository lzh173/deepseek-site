import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { env } from '../env.ts'
import { hashToken } from '../lib/crypto.ts'
import { forbidden, unauthorized } from '../lib/errors.ts'
import { isExpired } from '../lib/time.ts'
import type { Role } from '../db/types.ts'

type SessionRow = {
  expires_at: string
  id: string
  username: string
  role: Role
  daily_quota: number
  enabled: number
}

const SESSION_LOOKUP = `
  SELECT s.expires_at, u.id, u.username, u.role, u.daily_quota, u.enabled
  FROM auth_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`

/** 从 Cookie 里恢复登录态；必须在 @fastify/cookie 之后注册。 */
export const authPlugin = fp((app: FastifyInstance, _opts: unknown, done: () => void) => {
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[env.RAY_COOKIE_NAME]
    if (!token) {
      return
    }
    const row = app.db.prepare(SESSION_LOOKUP).get(hashToken(token)) as SessionRow | undefined
    if (!row || row.enabled !== 1 || isExpired(row.expires_at)) {
      return
    }
    request.user = {
      id: row.id,
      username: row.username,
      role: row.role,
      dailyQuota: row.daily_quota,
    }
  })
  done()
})

export const requireUser = async (request: FastifyRequest): Promise<void> => {
  if (!request.user) {
    throw unauthorized()
  }
}

export const requireAdmin = async (request: FastifyRequest): Promise<void> => {
  if (!request.user) {
    throw unauthorized()
  }
  if (request.user.role !== 'admin') {
    throw forbidden('需要管理员权限')
  }
}
