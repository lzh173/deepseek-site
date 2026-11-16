import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ModelCaps, ModelRow } from '../../db/types.ts'
import { emptyCaps } from '../../db/types.ts'
import { badRequest, conflict, notFound } from '../../lib/errors.ts'

/**
 * 管理端「模型」页：公开模型定义 + Key ⇄ 上游模型映射矩阵（GOAL.md §14）。
 *
 * 公开模型本身只是一个名字/一条池子；真正决定「谁能被谁调用」的是 key_models，
 * 所以这里只管模型元数据与能力位，映射编辑在 keys.ts 的 PUT /keys/:id/models。
 */

type CapsJson = Partial<ModelCaps>

/** caps_json 落库只存五个布尔位；读出来缺省一律按 false（与 routes/models.ts 口径一致）。 */
const parseCaps = (row: ModelRow): ModelCaps => {
  const raw = JSON.parse(row.caps_json || '{}') as CapsJson
  return {
    vision: raw.vision === true,
    reasoning: raw.reasoning === true,
    web_search: raw.web_search === true,
    read_url: raw.read_url === true,
    file_parse: raw.file_parse === true,
  }
}

const parseChain = (row: ModelRow): string[] => {
  const raw = JSON.parse(row.fallback_chain_json || '[]') as unknown
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}

/** PATCH 只带一部分能力位时与库里现有值合并，避免把没传的位冲成 false。 */
const mergeCaps = (base: ModelCaps, patch: Partial<ModelCaps>): ModelCaps => ({
  vision: patch.vision ?? base.vision,
  reasoning: patch.reasoning ?? base.reasoning,
  web_search: patch.web_search ?? base.web_search,
  read_url: patch.read_url ?? base.read_url,
  file_parse: patch.file_parse ?? base.file_parse,
})

const Caps = z.object({
  vision: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  web_search: z.boolean().default(false),
  read_url: z.boolean().default(false),
  file_parse: z.boolean().default(false),
})

const CreateBody = z.object({
  id: z.string().trim().min(1).max(64),
  display_name: z.string().trim().min(1).max(64),
  context: z.coerce.number().int().min(1).max(10_000_000).default(32_768),
  caps: Caps.optional(),
  tier: z.enum(['free', 'paid']),
  fallback_chain: z.array(z.string().trim().min(1).max(64)).max(16).default([]),
  enabled: z.boolean().default(true),
})

const UpdateBody = z.object({
  display_name: z.string().trim().min(1).max(64).optional(),
  context: z.coerce.number().int().min(1).max(10_000_000).optional(),
  caps: Caps.partial().optional(),
  tier: z.enum(['free', 'paid']).optional(),
  fallback_chain: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  enabled: z.boolean().optional(),
})

type MatrixRow = {
  key_id: string
  key_label: string
  channel_id: string
  channel_name: string
  upstream_model: string
  weight: number
  enabled: number
}

export const modelAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  const findModel = (id: string): ModelRow => {
    const row = app.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined
    if (!row) {
      throw notFound('模型不存在')
    }
    return row
  }

  const toPayload = (row: ModelRow) => ({
    id: row.id,
    display_name: row.display_name,
    context: row.context,
    tier: row.tier,
    enabled: row.enabled === 1,
    caps: parseCaps(row),
    fallback_chain: parseChain(row),
  })

  app.get('/models', async (request) => {
    const rows = app.db
      .prepare('SELECT * FROM models ORDER BY tier DESC, id ASC')
      .all() as ModelRow[]
    return { ray: request.ray, items: rows.map(toPayload) }
  })

  app.post('/models', async (request) => {
    const parsed = CreateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('模型参数不正确')
    }
    const body = parsed.data

    const exists = app.db.prepare('SELECT 1 FROM models WHERE id = ?').get(body.id)
    if (exists) {
      throw conflict('模型 ID 已存在')
    }

    app.db
      .prepare(
        `INSERT INTO models (id, display_name, context, caps_json, tier, fallback_chain_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.id,
        body.display_name,
        body.context,
        JSON.stringify(body.caps ?? emptyCaps()),
        body.tier,
        JSON.stringify(body.fallback_chain),
        body.enabled ? 1 : 0
      )

    return { ray: request.ray, item: toPayload(findModel(body.id)) }
  })

  app.patch<{ Params: { id: string } }>('/models/:id', async (request) => {
    const row = findModel(request.params.id)
    const parsed = UpdateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('模型参数不正确')
    }
    const body = parsed.data

    const sets: string[] = []
    const values: (string | number)[] = []
    if (body.display_name !== undefined) {
      sets.push('display_name = ?')
      values.push(body.display_name)
    }
    if (body.context !== undefined) {
      sets.push('context = ?')
      values.push(body.context)
    }
    if (body.caps !== undefined) {
      sets.push('caps_json = ?')
      values.push(JSON.stringify(mergeCaps(parseCaps(row), body.caps)))
    }
    if (body.tier !== undefined) {
      sets.push('tier = ?')
      values.push(body.tier)
    }
    if (body.fallback_chain !== undefined) {
      sets.push('fallback_chain_json = ?')
      values.push(JSON.stringify(body.fallback_chain))
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }
    if (sets.length === 0) {
      throw badRequest('没有需要修改的字段')
    }

    app.db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id)
    return { ray: request.ray, item: toPayload(findModel(row.id)) }
  })

  app.delete<{ Params: { id: string } }>('/models/:id', async (request) => {
    const row = findModel(request.params.id)

    app.db.transaction(() => {
      // key_models.public_model 是指向 models.id 的逻辑外键（schema 里没有 FK 约束），
      // 不手工清掉会留下永远匹配不到模型定义的悬空映射，路由时变成幽灵候选。
      app.db.prepare('DELETE FROM key_models WHERE public_model = ?').run(row.id)
      app.db.prepare('DELETE FROM models WHERE id = ?').run(row.id)
    })()

    return { ray: request.ray, ok: true }
  })

  /** Key ⇄ 上游模型映射矩阵：哪把 Key 能调这个公开模型的哪个上游模型。 */
  app.get<{ Params: { id: string } }>('/models/:id/matrix', async (request) => {
    const row = findModel(request.params.id)
    const rows = app.db
      .prepare(
        `SELECT km.key_id, k.label AS key_label, k.channel_id, c.name AS channel_name,
                km.upstream_model, km.weight, km.enabled
         FROM key_models km
         JOIN keys k ON k.id = km.key_id
         JOIN channels c ON c.id = k.channel_id
         WHERE km.public_model = ?
         ORDER BY c.name ASC, k.label ASC, km.upstream_model ASC`
      )
      .all(row.id) as MatrixRow[]

    return {
      ray: request.ray,
      model_id: row.id,
      items: rows.map((item) => ({
        key_id: item.key_id,
        key_label: item.key_label,
        channel_id: item.channel_id,
        channel_name: item.channel_name,
        upstream_model: item.upstream_model,
        weight: item.weight,
        enabled: item.enabled === 1,
      })),
    }
  })
}
