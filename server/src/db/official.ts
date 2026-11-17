import type { Db } from './index.ts'

/**
 * DeepSeek 官方渠道的固定配置。
 *
 * 「官方」在库里仍然是一条 kind = openai 的渠道（走 OpenAI 兼容协议），
 * 只是 base_url 固定、tier 固定 paid、并打上 official 标记；
 * 这样不用重建 channels 表去改 CHECK 约束，也不会影响现有渠道。
 */
export const OFFICIAL_BASE_URL = 'https://api.deepseek.com/v1'

export type OfficialModel = {
  id: string
  displayName: string
  upstreamModel: string
  context: number
  caps: {
    vision: boolean
    reasoning: boolean
    web_search: boolean
    read_url: boolean
    file_parse: boolean
  }
}

export const OFFICIAL_MODELS: OfficialModel[] = [
  {
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat（官方）',
    upstreamModel: 'deepseek-chat',
    context: 131_072,
    caps: { vision: false, reasoning: false, web_search: true, read_url: true, file_parse: true },
  },
  {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner（官方）',
    upstreamModel: 'deepseek-reasoner',
    context: 131_072,
    caps: { vision: false, reasoning: true, web_search: true, read_url: true, file_parse: true },
  },
]

/**
 * 确保两个官方模型存在（不存在才插入，已存在则保持管理员改过的配置）。
 * 返回本次新建的模型 id。
 */
export const ensureOfficialModels = (db: Db): string[] => {
  const created: string[] = []
  for (const model of OFFICIAL_MODELS) {
    const exists = db.prepare('SELECT 1 FROM models WHERE id = ?').get(model.id)
    if (exists) {
      continue
    }
    db.prepare(
      `INSERT INTO models (id, display_name, context, caps_json, tier, fallback_chain_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      model.id,
      model.displayName,
      model.context,
      JSON.stringify(model.caps),
      'paid',
      '[]',
      1
    )
    created.push(model.id)
  }
  return created
}

/**
 * 把某把 Key 映射到两个官方模型。已存在的映射不动，避免覆盖管理员调过的权重。
 * 返回新增的映射条数。
 */
export const mapOfficialModelsToKey = (db: Db, keyId: string): number => {
  let added = 0
  for (const model of OFFICIAL_MODELS) {
    const exists = db.prepare('SELECT 1 FROM key_models WHERE key_id = ? AND public_model = ?').get(
      keyId,
      model.id
    )
    if (exists) {
      continue
    }
    db.prepare(
      `INSERT INTO key_models (key_id, public_model, upstream_model, weight, enabled)
       VALUES (?, ?, ?, ?, ?)`
    ).run(keyId, model.id, model.upstreamModel, 1, 1)
    added += 1
  }
  return added
}
