import { verify } from '@node-rs/argon2'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRow } from '../db/types.ts'
import { env } from '../env.ts'
import { hashToken, randomToken } from '../lib/crypto.ts'
import { badRequest, unauthorized } from '../lib/errors.ts'
import { addDays, nowIso } from '../lib/time.ts'
import type { SessionUser } from '../lib/user.ts'

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

const toSessionUser = (row: UserRow): SessionUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  dailyQuota: row.daily_quota,
})

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('用户名或密码格式不正确')
    }
    const row = app.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(parsed.data.username) as UserRow | undefined

    if (!row || row.enabled !== 1) {
      throw unauthorized('用户名或密码错误')
    }

    const ok = await verify(row.pass_hash, parsed.data.password).catch(() => false)
    if (!ok) {
      throw unauthorized('用户名或密码错误')
    }

    const token = randomToken()
    app.db
      .prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        hashToken(token),
        row.id,
        addDays(env.RAY_SESSION_DAYS),
        nowIso(),
        request.headers['user-agent'] ?? null
      )

    void reply.setCookie(env.RAY_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.RAY_COOKIE_SECURE === 'true',
      maxAge: env.RAY_SESSION_DAYS * 86_400,
    })

    return { ray: request.ray, user: toSessionUser(row) }
  })

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[env.RAY_COOKIE_NAME]
    if (token) {
      app.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token))
    }
    void reply.clearCookie(env.RAY_COOKIE_NAME, { path: '/' })
    return { ray: request.ray, ok: true }
  })

  /** 前端启动时调用：返回当前登录用户，未登录返回 user: null（不报错）。 */
  app.get('/me', async (request) => ({
    ray: request.ray,
    user: request.user,
  }))
}
