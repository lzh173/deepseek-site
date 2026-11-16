/** 数据库行类型。全字段 snake_case，与 0001_init.sql 一一对应。 */

export type Role = 'admin' | 'user'

export type UserRow = {
  id: string
  username: string
  pass_hash: string
  role: Role
  enabled: number
  daily_quota: number
  created_at: string
}

export type AuthSessionRow = {
  token_hash: string
  user_id: string
  expires_at: string
  created_at: string
  user_agent: string | null
}

export type ChannelKind = 'openai' | 'anthropic' | 'gemini' | 'ollama'
export type ChannelTier = 'paid' | 'free'

export type ChannelRow = {
  id: string
  name: string
  kind: ChannelKind
  base_url: string
  tier: ChannelTier
  priority: number
  timeout_ms: number
  concurrency: number
  enabled: number
  created_at: string
}

export type KeyStatus = 'active' | 'cooling' | 'disabled'

export type KeyRow = {
  id: string
  channel_id: string
  key_cipher: string
  label: string
  group_label: string | null
  weight: number
  status: KeyStatus
  cooldown_until: string | null
  daily_quota: number
  fail_count: number
  last_ok_at: string | null
  created_at: string
}

export type KeyModelRow = {
  key_id: string
  public_model: string
  upstream_model: string
  weight: number
  enabled: number
}

export type KeyUsageRow = {
  key_id: string
  day: string
  requests: number
  tokens: number
}

export type ModelRow = {
  id: string
  display_name: string
  context: number
  caps_json: string
  tier: ChannelTier
  fallback_chain_json: string
  enabled: number
}

export type GrantRow = {
  user_id: string
  model_id: string
  key_id: string
  expires_at: string | null
}

export type SessionRow = {
  id: string
  user_id: string
  title: string
  payload: string
  created_at: string
  updated_at: string
}

export type FileRow = {
  sha256: string
  size: number
  mime: string
  name: string
  ref_count: number
  created_at: string
}

export type UsageLogRow = {
  ray: string
  ts: string
  user_id: string | null
  channel_id: string | null
  key_id: string | null
  public_model: string | null
  upstream_model: string | null
  in_tok: number | null
  out_tok: number | null
  ms: number | null
  status: string | null
  err: string | null
}

/** 模型能力位；null 表示按池子取交集后未知。 */
export type ModelCaps = {
  vision: boolean
  reasoning: boolean
  web_search: boolean
  read_url: boolean
  file_parse: boolean
}

export const emptyCaps = (): ModelCaps => ({
  vision: false,
  reasoning: false,
  web_search: false,
  read_url: false,
  file_parse: false,
})
