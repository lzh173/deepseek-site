import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UsageLogRow } from '../../db/types.ts'
import { badRequest } from '../../lib/errors.ts'

/**
 * 管理端「日志」页：按 ray / 用户 / 模型 / 状态 / 时间窗检索 usage_log（GOAL.md §12、§14）。
 *
 * ray 是主键，所以按 ray 查是精确匹配——后台就是拿错误信息里那串编号来对账的。
 * ts 存的是 UTC ISO 字符串，字典序等于时间序，from/to 直接按字符串比较即可。
 */

/** 空串按「没传」处理：前端把空 input 原样拼进 URL 时不该整页 400。 */
const pageNumber = (def: number, min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(min).max(max).default(def)
  )

const ListQuery = z.object({
  ray: z.string().trim().max(64).optional(),
  userId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(64).optional(),
  status: z.string().trim().max(32).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  limit: pageNumber(50, 1, 500),
  offset: pageNumber(0, 0, 1_000_000),
})

export const logRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/logs', async (request) => {
    const parsed = ListQuery.safeParse(request.query)
    if (!parsed.success) {
      throw badRequest('查询参数不正确')
    }
    const query = parsed.data

    const where: string[] = []
    const values: string[] = []
    if (query.ray) {
      where.push('ray = ?')
      values.push(query.ray)
    }
    if (query.userId) {
      where.push('user_id = ?')
      values.push(query.userId)
    }
    if (query.model) {
      where.push('public_model = ?')
      values.push(query.model)
    }
    if (query.status) {
      where.push('status = ?')
      values.push(query.status)
    }
    if (query.from) {
      where.push('ts >= ?')
      values.push(query.from)
    }
    if (query.to) {
      where.push('ts <= ?')
      values.push(query.to)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    // total 用同一套条件单独数一次：前端要做分页器，必须有总数
    const total = (
      app.db.prepare(`SELECT COUNT(*) AS n FROM usage_log ${whereSql}`).get(...values) as {
        n: number
      }
    ).n

    const items = app.db
      .prepare(
        `SELECT * FROM usage_log
         ${whereSql}
         ORDER BY ts DESC
         LIMIT ? OFFSET ?`
      )
      .all(...values, query.limit, query.offset) as UsageLogRow[]

    return { ray: request.ray, total, items }
  })
}
