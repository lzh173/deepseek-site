import type { Db } from './index.ts'
import { env } from '../env.ts'

/**
 * DeepSeek 官方渠道的固定配置（依据官方文档 2026-11 版）。
 *
 * 关键点：
 * - OpenAI 兼容的 BASE URL 是 https://api.deepseek.com（**不带 /v1**）
 * - 模型名只有 deepseek-flash 与 deepseek-v4-pro
 * - deepseek-flash 支持图像理解，v4-pro 不支持
 * - 两者都支持 thinking / title / safety_check / 联网工具（deepseek_web_search、deepseek_read_url）
 *
 * 「官方」在库里仍是一条 kind = openai 的渠道，用 official 标记区分，
 * 这样不用重建 channels 表去改 CHECK 约束。
 */
export const OFFICIAL_BASE_URL = (env.RAY_OFFICIAL_BASE_URL ?? 'https://api.deepseek.com').replace(
  /\/+$/,
  ''
)

/** 上下文 1M、输出 384K —— 这里只需登记上下文窗口 */
const OFFICIAL_CONTEXT = 1_048_576

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
    id: 'deepseek-flash',
    displayName: 'DeepSeek Flash（官方）',
    upstreamModel: 'deepseek-flash',
    context: OFFICIAL_CONTEXT,
    caps: { vision: true, reasoning: true, web_search: true, read_url: true, file_parse: true },
  },
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro（官方）',
    upstreamModel: 'deepseek-v4-pro',
    context: OFFICIAL_CONTEXT,
    caps: { vision: false, reasoning: true, web_search: true, read_url: true, file_parse: true },
  },
]

/** 旧版本（未按文档核对时）自动建出来的错误模型名，启动时清理掉。 */
const LEGACY_MODEL_IDS = ['deepseek-chat', 'deepseek-reasoner']

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

/**
 * 启动时校正已存在的官方渠道：
 * 1. base_url 统一成官方地址（早期版本误写成 /v1）
 * 2. 补齐两个官方模型
 * 3. 把官方渠道下的每把 Key 补上映射
 * 4. 清掉旧模型名（只有在无人引用时才删，避免破坏历史会话的展示）
 */
export const syncOfficialChannels = (db: Db): void => {
  const channels = db
    .prepare('SELECT id, base_url FROM channels WHERE official = 1')
    .all() as { id: string; base_url: string }[]
  if (channels.length === 0) {
    return
  }

  const changed: string[] = []
  for (const channel of channels) {
    if (channel.base_url !== OFFICIAL_BASE_URL) {
      db.prepare('UPDATE channels SET base_url = ? WHERE id = ?').run(OFFICIAL_BASE_URL, channel.id)
      changed.push(`channel ${channel.id} base_url`)
    }
  }

  changed.push(...ensureOfficialModels(db).map((id) => `model ${id}`))

  const keys = db
    .prepare(
      'SELECT k.id FROM keys k JOIN channels c ON c.id = k.channel_id WHERE c.official = 1'
    )
    .all() as { id: string }[]
  let mapped = 0
  for (const key of keys) {
    mapped += mapOfficialModelsToKey(db, key.id)
  }
  if (mapped > 0) {
    changed.push(`${mapped} key mapping(s)`)
  }

  for (const id of LEGACY_MODEL_IDS) {
    // 早期版本把官方 Key 自动映射到了这两个不存在的模型名，先清掉这些映射
    const cleaned = db
      .prepare(
        `DELETE FROM key_models
         WHERE public_model = ?
           AND key_id IN (
             SELECT k.id FROM keys k JOIN channels c ON c.id = k.channel_id WHERE c.official = 1
           )`
      )
      .run(id)
    if (cleaned.changes > 0) {
      changed.push(`legacy mapping ${id} ×${cleaned.changes}`)
    }

    // 只有没人再引用时才删模型本身，避免破坏历史会话的展示
    const stillUsed =
      db.prepare('SELECT 1 FROM key_models WHERE public_model = ? LIMIT 1').get(id) ??
      db.prepare('SELECT 1 FROM grants WHERE model_id = ? LIMIT 1').get(id)
    if (stillUsed) {
      continue
    }
    const removed = db.prepare('DELETE FROM models WHERE id = ?').run(id)
    if (removed.changes > 0) {
      changed.push(`legacy model ${id} removed`)
    }
  }

  if (changed.length > 0) {
    console.log(`[ray] 官方渠道已校正：${changed.join('、')}`)
  }
}
