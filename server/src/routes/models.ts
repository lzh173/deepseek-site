import type { FastifyInstance } from 'fastify'
import type { ModelCaps, ModelRow } from '../db/types.ts'
import { requireUser } from '../plugins/auth.ts'

type CapsJson = Partial<ModelCaps>

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

/** 该用户可用且当前有可用 Key 的模型列表；付费模型无授权时直接不返回。 */
export const modelRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/models', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    const now = new Date().toISOString()

    const rows = app.db
      .prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY tier DESC, id ASC')
      .all() as ModelRow[]

    const grantedModels = new Set(
      (
        app.db
          .prepare(
            `SELECT DISTINCT g.model_id
             FROM grants g
             JOIN keys k ON k.id = g.key_id
             WHERE g.user_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?)`
          )
          .all(user.id, now) as { model_id: string }[]
      ).map((row) => row.model_id)
    )

    const models = rows
      .filter((row) => row.tier === 'free' || user.role === 'admin' || grantedModels.has(row.id))
      .map((row) => {
        const available = app.db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM key_models km
             JOIN keys k ON k.id = km.key_id
             JOIN channels c ON c.id = k.channel_id
             WHERE km.public_model = ? AND km.enabled = 1 AND k.status = 'active'
               AND (k.cooldown_until IS NULL OR k.cooldown_until < ?) AND c.enabled = 1`
          )
          .get(row.id, now) as { n: number }

        return {
          id: row.id,
          display_name: row.display_name,
          tier: row.tier,
          available: available.n > 0,
          context: row.context,
          caps: parseCaps(row),
        }
      })

    return { ray: request.ray, models }
  })
}
