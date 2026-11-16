import { copy } from './copy.js'

/**
 * 管理端 fetch 封装。
 *
 * · 同源 + Cookie 会话（credentials: 'include'），与主站共用 /api；
 * · 后端响应外层统一带 ray，这里原样透传给调用方，便于在界面上排错；
 * · 出错时把后端返回的 error.message 直接抛出去（里面已经带请求编号），页面只需 toast。
 *
 * 注意：这里不缓存、不重试、不吞异常——重试逻辑留给页面按业务决定。
 */

/** 构建期注入的 API 地址；入口没注入时退化为同源 */
const origin = typeof __API_ORIGIN__ === 'undefined' ? '' : __API_ORIGIN__
const baseUrl = `${origin}/api`

export class AdminApiError extends Error {
  /** HTTP 状态码；请求没能到达服务端时为 0 */
  readonly status: number
  readonly ray: string | null
  readonly type: string | null

  constructor(message: string, status = 0, ray: string | null = null, type: string | null = null) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.ray = ray
    this.type = type
  }
}

/** 把任意异常转成可直接展示的一句话 */
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return copy.common.unknownError
}

export type ChannelKind = 'openai' | 'anthropic' | 'gemini' | 'ollama'
export type Tier = 'paid' | 'free'
export type KeyStatus = 'active' | 'cooling' | 'disabled'
export type Role = 'admin' | 'user'

export type Caps = {
  vision: boolean
  reasoning: boolean
  web_search: boolean
  read_url: boolean
  file_parse: boolean
}

export type CapsKey = keyof Caps

/** 当前登录用户；字段与 BFF 的 SessionUser 一致 */
export type AdminUser = {
  id: string
  username: string
  role: Role
  dailyQuota?: number
}

export type Channel = {
  id: string
  name: string
  kind: ChannelKind
  base_url: string
  tier: Tier
  priority: number
  timeout_ms: number
  concurrency: number
  enabled: boolean
  created_at: string
  key_count: number
}

export type ChannelInput = {
  name: string
  kind: ChannelKind
  base_url: string
  tier: Tier
  priority: number
  timeout_ms: number
  concurrency: number
  enabled: boolean
}

export type ChannelPatch = Partial<ChannelInput>

export type KeyModel = {
  public_model: string
  upstream_model: string
  weight: number
  enabled: boolean
}

export type KeyItem = {
  id: string
  channel_id: string
  label: string
  group_label: string | null
  weight: number
  status: KeyStatus
  cooldown_until: string | null
  daily_quota: number
  fail_count: number
  last_ok_at: string | null
  created_at: string
  secret_masked: string
  used_today: number
  models: KeyModel[]
}

export type KeyImportInput = {
  channel_id: string
  keys: string
  label?: string
  group_label?: string | null
  weight?: number
  daily_quota?: number
}

export type KeyPatch = {
  label?: string
  group_label?: string | null
  weight?: number
  daily_quota?: number
}

export type Model = {
  id: string
  display_name: string
  context: number
  tier: Tier
  enabled: boolean
  caps: Caps
  fallback_chain: string[]
}

export type ModelInput = {
  id: string
  display_name: string
  context: number
  caps: Caps
  tier: Tier
  fallback_chain: string[]
  enabled: boolean
}

export type ModelPatch = Partial<Omit<ModelInput, 'id'>>

export type MatrixRow = {
  key_id: string
  key_label: string
  channel_id: string
  channel_name: string
  upstream_model: string
  weight: number
  enabled: boolean
}

export type User = {
  id: string
  username: string
  role: Role
  enabled: boolean
  daily_quota: number
  created_at: string
}

export type UserInput = {
  username: string
  password: string
  role: Role
  /** 不传时用服务端的默认日配额 */
  daily_quota?: number
}

export type UserPatch = {
  role?: Role
  enabled?: boolean
  daily_quota?: number
  password?: string
}

export type Grant = {
  model_id: string
  key_id: string
  expires_at: string | null
}

export type GrantInput = {
  model_id: string
  key_id: string
  expires_at: string | null
}

export type LogItem = {
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

export type LogQuery = {
  ray?: string
  userId?: string
  model?: string
  status?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export type SystemInfo = {
  db: { path: string; size_bytes: number; wal_bytes: number }
  files: { dir: string; count: number; bytes: number }
  tables: { name: string; rows: number }[]
}

/** 探活结果：失败不是异常，而是这个结构的一部分 */
export type ProbeResult = {
  channel_id?: string
  key_id?: string
  ok: boolean
  status: number | null
  latency_ms: number
  error?: string
}

type Envelope = { ray: string }
type ListResult<T> = Envelope & { items: T[] }
type ItemResult<T> = Envelope & { item: T }
type OkResult = Envelope & { ok: true }

export type Query = Record<string, string | number | boolean | null | undefined>

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  query?: Query
  body?: unknown
  signal?: AbortSignal
}

const buildUrl = (path: string, query?: Query): string => {
  if (!query) {
    return `${baseUrl}${path}`
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `${baseUrl}${path}?${text}` : `${baseUrl}${path}`
}

/** 统一按 {ray, ...} 解析；非 2xx 抛 AdminApiError，message 直接来自后端 */
const requestJson = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const { method = 'GET', query, body, signal } = options
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response: Response
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      signal,
    })
  } catch (error) {
    // 主动取消要原样抛，否则页面会把"切换筛选"当成网络故障提示
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    throw new AdminApiError(copy.common.networkError, 0)
  }

  if (!response.ok) {
    throw await readError(response)
  }

  const text = await response.text()
  if (!text) {
    return { ray: '' } as T
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AdminApiError(copy.common.badResponse, response.status)
  }
}

type ErrorBody = { ray?: string; error?: { message?: string; type?: string } }

/** 后端错误体是 {ray, error:{type,message}}；解析不出来时退化成状态码文案 */
const readError = async (response: Response): Promise<AdminApiError> => {
  const text = await response.text().catch(() => '')
  let ray: string | null = null
  let message = text || copy.common.requestFailed(response.status)
  let type: string | null = null
  try {
    const body = JSON.parse(text) as ErrorBody
    if (typeof body.ray === 'string') {
      ray = body.ray
    }
    if (typeof body.error?.message === 'string' && body.error.message.length > 0) {
      message = body.error.message
    }
    if (typeof body.error?.type === 'string') {
      type = body.error.type
    }
  } catch {
    // 非 JSON 响应体：保留原文（可能是网关返回的 HTML）
  }
  return new AdminApiError(message, response.status, ray, type)
}

const idPath = (id: string) => encodeURIComponent(id)

export const api = {
  /** GET /api/me：未登录返回 user: null，不报错 */
  me: () => requestJson<Envelope & { user: AdminUser | null }>('/me'),
  logout: () => requestJson<OkResult>('/auth/logout', { method: 'POST' }),

  channels: {
    list: () => requestJson<ListResult<Channel>>('/admin/channels'),
    create: (body: ChannelInput) =>
      requestJson<ItemResult<Channel>>('/admin/channels', { method: 'POST', body }),
    update: (id: string, body: ChannelPatch) =>
      requestJson<ItemResult<Channel>>(`/admin/channels/${idPath(id)}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      requestJson<OkResult>(`/admin/channels/${idPath(id)}`, { method: 'DELETE' }),
    test: (id: string) =>
      requestJson<ProbeResult>(`/admin/channels/${idPath(id)}/test`, { method: 'POST' }),
  },

  keys: {
    list: (query?: { channelId?: string; status?: string }) =>
      requestJson<ListResult<KeyItem>>('/admin/keys', { query }),
    import: (body: KeyImportInput) =>
      requestJson<Envelope & { created: number; items: KeyItem[] }>('/admin/keys', {
        method: 'POST',
        body,
      }),
    update: (id: string, body: KeyPatch) =>
      requestJson<ItemResult<KeyItem>>(`/admin/keys/${idPath(id)}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      requestJson<OkResult>(`/admin/keys/${idPath(id)}`, { method: 'DELETE' }),
    test: (id: string) =>
      requestJson<ProbeResult>(`/admin/keys/${idPath(id)}/test`, { method: 'POST' }),
    reset: (id: string) =>
      requestJson<ItemResult<KeyItem>>(`/admin/keys/${idPath(id)}/reset`, { method: 'POST' }),
    putModels: (id: string, models: KeyModel[]) =>
      requestJson<ItemResult<KeyItem>>(`/admin/keys/${idPath(id)}/models`, {
        method: 'PUT',
        body: { models },
      }),
  },

  models: {
    list: () => requestJson<ListResult<Model>>('/admin/models'),
    create: (body: ModelInput) =>
      requestJson<ItemResult<Model>>('/admin/models', { method: 'POST', body }),
    update: (id: string, body: ModelPatch) =>
      requestJson<ItemResult<Model>>(`/admin/models/${idPath(id)}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      requestJson<OkResult>(`/admin/models/${idPath(id)}`, { method: 'DELETE' }),
    matrix: (id: string) =>
      requestJson<Envelope & { model_id: string; items: MatrixRow[] }>(
        `/admin/models/${idPath(id)}/matrix`
      ),
  },

  users: {
    list: () => requestJson<ListResult<User>>('/admin/users'),
    create: (body: UserInput) =>
      requestJson<ItemResult<User>>('/admin/users', { method: 'POST', body }),
    update: (id: string, body: UserPatch) =>
      requestJson<ItemResult<User>>(`/admin/users/${idPath(id)}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      requestJson<OkResult>(`/admin/users/${idPath(id)}`, { method: 'DELETE' }),
    grants: (id: string) =>
      requestJson<Envelope & { grants: Grant[] }>(`/admin/users/${idPath(id)}/grants`),
    putGrants: (id: string, grants: GrantInput[]) =>
      requestJson<Envelope & { grants: Grant[] }>(`/admin/users/${idPath(id)}/grants`, {
        method: 'PUT',
        body: { grants },
      }),
  },

  logs: {
    list: (query: LogQuery = {}) =>
      requestJson<Envelope & { total: number; items: LogItem[] }>('/admin/logs', { query }),
  },

  system: {
    info: () => requestJson<Envelope & SystemInfo>('/admin/system'),
    cleanup: () =>
      requestJson<Envelope & { removed: number; freed_bytes: number }>('/admin/system/cleanup', {
        method: 'POST',
      }),
  },
}
