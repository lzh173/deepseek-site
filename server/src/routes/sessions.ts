import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { badRequest, notFound } from '../lib/errors.ts'
import { requireUser } from '../plugins/auth.ts'
import {
  deleteSession,
  findSession,
  listSessions,
  renameSession,
  saveSession,
} from '../storage/sessions.ts'

/**
 * /api/sessions：整棵会话树的服务端唯一真源（GOAL.md §11.2）。
 * 前端只换实现不改调用方，所以列表/详情的字段名对齐成 snake_case；payload 原样存取，
 * 服务端只为了维护附件引用才读一次里面的 `files[].id / serverId`。
 */

/** 会话 id 由前端生成（uuid），这里只做长度限制，实际查询一律参数化并带 user_id。 */
const IdParams = z.object({ id: z.string().min(1).max(200) })

/** 标题长度上限；空串表示"无标题"，与新建会话的默认值一致。 */
const TitleSchema = z.string().max(512)

const PutBody = z.object({
  title: TitleSchema.optional(),
  payload: z.string(),
})

const PatchBody = z.object({ title: TitleSchema })

const parseId = (params: unknown): string => {
  const parsed = IdParams.safeParse(params)
  if (!parsed.success) {
    throw badRequest('会话 id 不合法')
  }
  return parsed.data.id
}

export const sessionRoutes = async (app: FastifyInstance): Promise<void> => {
  /** 会话摘要列表，按 updated_at 倒序，最多 2000 条。 */
  app.get('/sessions', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    return { ray: request.ray, sessions: listSessions(app.db, user.id) }
  })

  /** 单个会话（含 payload）；不属于当前用户一律 404，不泄露存在性。 */
  app.get('/sessions/:id', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    const session = findSession(app.db, user.id, parseId(request.params))
    if (!session) {
      throw notFound('会话不存在')
    }
    return { ray: request.ray, session }
  })

  /** upsert：不存在则创建；payload 上限 8 MB，超了 413。 */
  app.put('/sessions/:id', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    const id = parseId(request.params)
    const body = PutBody.safeParse(request.body)
    if (!body.success) {
      throw badRequest('请求体格式不正确，需要 { title?, payload }')
    }
    const { session, created } = saveSession(app.db, user.id, id, body.data)
    return { ray: request.ray, session, created }
  })

  /** 只改标题，不动 payload 也不动 updated_at。 */
  app.patch('/sessions/:id', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    const id = parseId(request.params)
    const body = PatchBody.safeParse(request.body)
    if (!body.success) {
      throw badRequest('请求体格式不正确，需要 { title }')
    }
    const session = renameSession(app.db, user.id, id, body.data.title)
    if (!session) {
      throw notFound('会话不存在')
    }
    return { ray: request.ray, session }
  })

  /** 删除会话并回收附件引用；已删除或不属于本用户时同样返回 ok（幂等，不泄露存在性）。 */
  app.delete('/sessions/:id', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    const deleted = await deleteSession(app.db, user.id, parseId(request.params))
    return { ray: request.ray, ok: true, deleted }
  })
}
