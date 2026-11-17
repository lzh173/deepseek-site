import { hash } from '@node-rs/argon2'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GrantRow, Role, UserRow } from '../../db/types.ts'
import { env } from '../../env.ts'
import { randomId } from '../../lib/crypto.ts'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts'
import { nowIso } from '../../lib/time.ts'

/**
 * 管理端「用户」页：账号 CRUD + 付费白名单（GOAL.md §8、§14）。
 *
 * 白名单粒度是「Key × 模型」，model_id 与 key_id 都必填；
 * 写入前检查该 Key 在 key_models 里确实能调该模型，否则这条授权永远不会被选中。
 * 任何响应都不含 pass_hash。
 */

/** 出网关的用户视图：显式列字段，避免把 pass_hash 漏出去。 */
type UserPayload = {
  id: string
  username: string
  role: Role
  enabled: boolean
  daily_quota: number
  created_at: string
}

/** 列表只查这几列，从查询层就不给 pass_hash 机会被带出来。 */
type UserViewRow = Omit<UserRow, 'pass_hash'>

const CreateBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(6).max(256),
  role: z.enum(['admin', 'user']).default('user'),
  daily_quota: z.coerce.number().int().min(0).default(env.RAY_USER_DAILY_QUOTA),
})

/** 空密码框按「不修改」处理，免得前端每次保存都把整张表单原样提交时被 400 拦下。 */
const OptionalPassword = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().min(6).max(256).optional()
)

/** PATCH 只改传了的字段；password 为空串时按未传处理（见上面的 OptionalPassword）。 */
const UpdateBody = z.object({
  role: z.enum(['admin', 'user']).optional(),
  enabled: z.boolean().optional(),
  daily_quota: z.coerce.number().int().min(0).optional(),
  password: OptionalPassword,
})

const GrantsBody = z.object({
  grants: z
    .array(
      z.object({
        model_id: z.string().trim().min(1).max(64),
        key_id: z.string().trim().min(1).max(64),
        /** null / 省略 = 永久有效；传了就按 ISO 时间解析 */
        expires_at: z.string().trim().max(40).nullable().optional(),
      })
    )
    .max(1_000),
})

/** 当前登录管理员的 id；用于禁止自删与自我降级/停用。 */
const selfId = (request: { user: { id: string } | null }): string | null =>
  request.user ? request.user.id : null

export const userAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  const findUser = (id: string): UserRow => {
    const row = app.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    if (!row) {
      throw notFound('用户不存在')
    }
    return row
  }

  const toPayload = (row: UserViewRow): UserPayload => ({
    id: row.id,
    username: row.username,
    role: row.role,
    enabled: row.enabled === 1,
    daily_quota: row.daily_quota,
    created_at: row.created_at,
  })

  /** 到期时间统一落 UTC ISO；空串按「永久」处理，便于前端把空输入框直接提交。 */
  const normalizeExpires = (value: string | null | undefined): string | null => {
    if (value === undefined || value === null || value.length === 0) {
      return null
    }
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) {
      throw badRequest(`到期时间格式不正确：${value}`)
    }
    return new Date(ms).toISOString()
  }

  const listGrants = (userId: string) =>
    app.db
      .prepare(
        'SELECT model_id, key_id, expires_at FROM grants WHERE user_id = ? ORDER BY model_id ASC, key_id ASC'
      )
      .all(userId) as Pick<GrantRow, 'model_id' | 'key_id' | 'expires_at'>[]

  app.get('/users', async (request) => {
    const rows = app.db
      .prepare(
        'SELECT id, username, role, enabled, daily_quota, created_at FROM users ORDER BY created_at ASC'
      )
      .all() as UserViewRow[]
    return { ray: request.ray, items: rows.map(toPayload) }
  })

  app.post('/users', async (request) => {
    const parsed = CreateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('用户参数不正确')
    }
    const body = parsed.data

    const exists = app.db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username)
    if (exists) {
      throw conflict('用户名已存在')
    }

    const id = randomId('usr')
    const passHash = await hash(body.password)
    app.db
      .prepare(
        `INSERT INTO users (id, username, pass_hash, role, enabled, daily_quota, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run(id, body.username, passHash, body.role, body.daily_quota, nowIso())

    return { ray: request.ray, item: toPayload(findUser(id)) }
  })

  app.patch<{ Params: { id: string } }>('/users/:id', async (request) => {
    const row = findUser(request.params.id)
    const parsed = UpdateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('用户参数不正确')
    }
    const body = parsed.data
    const me = selfId(request)

    // 防止把自己锁在门外：降级或停用当前登录账号等同自毁，直接拒绝
    if (me === row.id && body.role === 'user') {
      throw forbidden('不能取消自己的管理员权限')
    }
    if (me === row.id && body.enabled === false) {
      throw forbidden('不能停用当前登录的账号')
    }

    const sets: string[] = []
    const values: (string | number)[] = []
    if (body.role !== undefined) {
      sets.push('role = ?')
      values.push(body.role)
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }
    if (body.daily_quota !== undefined) {
      sets.push('daily_quota = ?')
      values.push(body.daily_quota)
    }
    if (body.password !== undefined) {
      sets.push('pass_hash = ?')
      values.push(await hash(body.password))
    }
    if (sets.length === 0) {
      throw badRequest('没有需要修改的字段')
    }

    app.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id)
    return { ray: request.ray, item: toPayload(findUser(row.id)) }
  })

  app.delete<{ Params: { id: string } }>('/users/:id', async (request) => {
    const row = findUser(request.params.id)
    if (selfId(request) === row.id) {
      throw forbidden('不能删除自己')
    }
    // auth_sessions / grants / sessions / user_prefs 均靠 ON DELETE CASCADE 连带清理
    app.db.prepare('DELETE FROM users WHERE id = ?').run(row.id)
    return { ray: request.ray, ok: true }
  })

  app.get<{ Params: { id: string } }>('/users/:id/grants', async (request) => {
    const row = findUser(request.params.id)
    return { ray: request.ray, grants: listGrants(row.id) }
  })

  app.put<{ Params: { id: string } }>('/users/:id/grants', async (request) => {
    const row = findUser(request.params.id)
    const parsed = GrantsBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('白名单参数不正确')
    }

    // 一次取出「启用中的 Key × 公开模型」全集，避免逐条查询
    const callable = new Set(
      (
        app.db
          .prepare('SELECT DISTINCT key_id, public_model FROM key_models WHERE enabled = 1')
          .all() as { key_id: string; public_model: string }[]
      ).map((item) => `${item.public_model}\u0000${item.key_id}`)
    )
    const modelIds = new Set(
      (app.db.prepare('SELECT id FROM models').all() as { id: string }[]).map((item) => item.id)
    )

    const items = parsed.data.grants.map((grant) => ({
      model_id: grant.model_id,
      key_id: grant.key_id,
      expires_at: normalizeExpires(grant.expires_at),
    }))

    const unknownModels = [...new Set(items.map((item) => item.model_id))].filter(
      (modelId) => !modelIds.has(modelId)
    )
    if (unknownModels.length > 0) {
      throw badRequest(`模型不存在：${unknownModels.join('、')}`)
    }

    // GOAL.md §8：授权的 Key 必须真的在 key_models 里能调该模型，否则这条 grant 是死信
    const invalid = items.filter((item) => !callable.has(`${item.model_id}\u0000${item.key_id}`))
    if (invalid.length > 0) {
      const detail = invalid
        .slice(0, 5)
        .map((item) => `${item.model_id} × ${item.key_id}`)
        .join('、')
      throw badRequest(`以下 Key 不能调用对应模型：${detail}${invalid.length > 5 ? ' 等' : ''}`)
    }

    // 主键是 (user_id, model_id, key_id)，同组合重复只留最后一条
    const unique = new Map<string, (typeof items)[number]>()
    for (const item of items) {
      unique.set(`${item.model_id}\u0000${item.key_id}`, item)
    }

    const insert = app.db.prepare(
      'INSERT INTO grants (user_id, model_id, key_id, expires_at) VALUES (?, ?, ?, ?)'
    )
    app.db.transaction(() => {
      // 全量替换：先清空该用户所有授权，再按请求重建
      app.db.prepare('DELETE FROM grants WHERE user_id = ?').run(row.id)
      for (const item of unique.values()) {
        insert.run(row.id, item.model_id, item.key_id, item.expires_at)
      }
    })()

    return { ray: request.ray, grants: listGrants(row.id) }
  })
}
