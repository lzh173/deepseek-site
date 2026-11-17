import type { FastifyInstance } from 'fastify'
import { request } from 'undici'
import { z } from 'zod'
import type { ChannelRow } from '../../db/types.ts'
import { ensureOfficialModels, OFFICIAL_BASE_URL } from '../../db/official.ts'
import { decryptSecret, randomId } from '../../lib/crypto.ts'
import { badRequest, notFound } from '../../lib/errors.ts'
import { nowIso } from '../../lib/time.ts'

/**
 * 管理端「渠道」页（GOAL.md §14）。
 *
 * 渠道只承载 base_url 与鉴权方式，模型可达性完全由 key_models 决定，本文件不碰映射。
 * 连通性测试打的是 {base_url}/models：既验证渠道是否可达，也验证第一把可用 Key 是否被上游接受。
 */

/** 探活超时 5 秒，与 GOAL.md §7.4 的主动健康检查同一口径。 */
/**
 * 探活超时。官方接口冷启动实测要 3 秒以上，5 秒会误判成失败，
 * 这里放宽到 15 秒（探活是人工点击触发的，慢一点没关系）。
 */
const PROBE_TIMEOUT_MS = 15_000

/** 探活结果。失败不是异常，而是这个结构的一部分。 */
export type ProbeResult = {
  ok: boolean
  /** 上游 HTTP 状态码；连不上或超时时为 null。 */
  status: number | null
  latency_ms: number
  /** 响应是合法模型列表时，模型数量 */
  model_count?: number
  /** 面向人的修复建议（缩进、缺少 /v1、鉴权失败……） */
  hint?: string
  error?: string
}

const describeProbeError = (error: unknown): string => {
  if (error instanceof Error) {
    // AbortSignal.timeout 抛 TimeoutError，undici 自身中断抛 AbortError，统一成一句人话
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `请求超时（${PROBE_TIMEOUT_MS / 1_000} 秒）`
    }
    return error.message
  }
  return String(error)
}

/**
 * 探活最多读这么多响应体。OpenRouter 的 /models 就有 780KB，
 * 上限设小会把合法 JSON 截断成「不是合法 JSON」——这类误判比多读几 MB 更糟。
 */
const PROBE_MAX_BODY = 8 * 1024 * 1024

/**
 * GET {base_url}/models 探活；keys.ts 的单 Key 测试复用同一实现，故导出。
 *
 * 不只检查状态码：很多站点对任意路径都回 200 的 HTML 页，
 * 只status 判断会把「base_url 少了 /v1」这种最常见配置错误当成成功。
 * 这里要求响应确实是 JSON 且带 data 数组，否则给出具体提示。
 */
export const probeModels = async (baseUrl: string, secret: string | null): Promise<ProbeResult> => {
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}/models`
  const started = Date.now()
  const fail = (error: string, hint?: string, status: number | null = null): ProbeResult => ({
    ok: false,
    status,
    latency_ms: Date.now() - started,
    ...(hint === undefined ? {} : { hint }),
    error,
  })

  try {
    const response = await request(url, {
      method: 'GET',
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const contentType = String(response.headers['content-type'] ?? '')
    const raw = await response.body.text()
    const body = raw.length > PROBE_MAX_BODY ? raw.slice(0, PROBE_MAX_BODY) : raw
    const status = response.statusCode
    const latency = Date.now() - started

    // 鉴权类失败：key 错、没权限、余额不足
    if (status === 401 || status === 403) {
      return {
        ...fail(`上游拒绝鉴权（HTTP ${status}）`, `检查 API Key 是否正确、是否有该渠道权限`, status),
        latency_ms: latency,
      }
    }
    if (status === 404) {
      return {
        ...fail(`端点不存在（HTTP 404）`, `base_url 可能少了 /v1 之类的路径前缀，或该服务不提供 /models`, status),
        latency_ms: latency,
      }
    }
    if (status < 200 || status >= 300) {
      return {
        ...fail(`上游返回 HTTP ${status}`, '查看上游返回的正文确认原因', status),
        latency_ms: latency,
      }
    }

    // 200 但返回 HTML：最常见的「地址写错」
    if (contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(body)) {
      return {
        ...fail(
          '返回的是 HTML 页面，不是 API 响应',
          `base_url 看起来是站点首页。多数 OpenAI 兼容服务要写成 ${base}/v1（DeepSeek 官方除外，它不带 /v1）`,
          status
        ),
        latency_ms: latency,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return {
        ...fail('响应不是合法 JSON', '确认 base_url 指向的是 OpenAI 兼容接口', status),
        latency_ms: latency,
      }
    }

    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data)) {
      return {
        ...fail(
          'JSON 里没有 data 数组，不像模型列表',
          '确认 base_url 指向的是 OpenAI 兼容接口根路径（通常以 /v1 结尾）',
          status
        ),
        latency_ms: latency,
      }
    }

    return {
      ok: true,
      status,
      latency_ms: latency,
      model_count: data.length,
      ...(data.length === 0
        ? { hint: '接口可达，但模型列表为空：确认这把 Key 是否已开通模型' }
        : {}),
    }
  } catch (error) {
    // 探活失败本就是预期结果之一：转成结构化返回值给前端展示，不是吞异常
    return fail(describeProbeError(error), '检查 base_url 是否可达、是否需要代理')
  }
}

const BaseUrl = z
  .string()
  .trim()
  .max(512)
  .url('base_url 必须是合法 URL')
  .refine((value) => /^https?:\/\//i.test(value), 'base_url 只支持 http/https')

const CreateBody = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(['openai', 'anthropic', 'gemini', 'ollama']).default('openai'),
  /** 官方渠道不需要填 base_url，服务端会固定成 DeepSeek 官方地址 */
  base_url: BaseUrl.optional(),
  tier: z.enum(['paid', 'free']).default('paid'),
  priority: z.coerce.number().int().min(0).max(10_000).default(100),
  timeout_ms: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  concurrency: z.coerce.number().int().min(1).max(64).default(4),
  enabled: z.boolean().default(true),
  /** true = DeepSeek 官方渠道：只填 API Key 即可用 */
  official: z.boolean().default(false),
})

/** PATCH 的字段全部可选；不传即不修改。 */
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  kind: z.enum(['openai', 'anthropic', 'gemini', 'ollama']).optional(),
  base_url: BaseUrl.optional(),
  tier: z.enum(['paid', 'free']).optional(),
  priority: z.coerce.number().int().min(0).max(10_000).optional(),
  timeout_ms: z.coerce.number().int().min(1_000).max(600_000).optional(),
  concurrency: z.coerce.number().int().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
})

export const channelRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * 取单个渠道。带上 key_count：新建/PATCH 的响应也要和列表页字段一致，
   * 否则前端刚保存完就会看到「Key 数」变成 0。
   */
  const findChannel = (id: string): ChannelRow & { key_count: number } => {
    const row = app.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM keys k WHERE k.channel_id = c.id) AS key_count
         FROM channels c WHERE c.id = ?`
      )
      .get(id) as (ChannelRow & { key_count: number }) | undefined
    if (!row) {
      throw notFound('渠道不存在')
    }
    return row
  }

  /** SQLite 布尔是 0/1，出网关前统一转 boolean。 */
  const toPayload = (row: ChannelRow & { key_count?: number }) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url,
    tier: row.tier,
    priority: row.priority,
    timeout_ms: row.timeout_ms,
    concurrency: row.concurrency,
    enabled: row.enabled === 1,
    official: row.official === 1,
    created_at: row.created_at,
    key_count: row.key_count ?? 0,
  })

  app.get('/channels', async (request) => {
    const rows = app.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM keys k WHERE k.channel_id = c.id) AS key_count
         FROM channels c
         ORDER BY c.priority ASC, c.created_at ASC`
      )
      .all() as (ChannelRow & { key_count: number })[]

    return { ray: request.ray, items: rows.map(toPayload) }
  })

  app.post('/channels', async (request) => {
    const parsed = CreateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('渠道参数不正确')
    }
    const body = parsed.data
    const id = randomId('chn')

    // 官方渠道：kind/base_url/tier 全部由服务端固定，用户只填名字与 Key
    const official = body.official
    const kind = official ? 'openai' : body.kind
    const baseUrl = official ? OFFICIAL_BASE_URL : (body.base_url ?? '')
    if (!official && baseUrl === '') {
      throw badRequest('base_url 不能为空')
    }

    app.db
      .prepare(
        `INSERT INTO channels (id, name, kind, base_url, tier, priority, timeout_ms, concurrency, enabled, official, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        body.name,
        kind,
        // 末尾斜杠统一去掉，探活与上游调用都靠拼 path，避免出现 //
        baseUrl.replace(/\/+$/, ''),
        official ? 'paid' : body.tier,
        body.priority,
        body.timeout_ms,
        body.concurrency,
        body.enabled ? 1 : 0,
        official ? 1 : 0,
        nowIso()
      )

    // 官方渠道建好就把两个官方模型补齐，管理员接下来只需要贴 Key
    const createdModels = official ? ensureOfficialModels(app.db) : []

    return { ray: request.ray, item: toPayload(findChannel(id)), created_models: createdModels }
  })

  app.patch<{ Params: { id: string } }>('/channels/:id', async (request) => {
    const { id } = request.params
    findChannel(id)

    const parsed = UpdateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('渠道参数不正确')
    }
    const body = parsed.data

    const sets: string[] = []
    const values: (string | number)[] = []
    if (body.name !== undefined) {
      sets.push('name = ?')
      values.push(body.name)
    }
    if (body.kind !== undefined) {
      sets.push('kind = ?')
      values.push(body.kind)
    }
    if (body.base_url !== undefined) {
      sets.push('base_url = ?')
      values.push(body.base_url.replace(/\/+$/, ''))
    }
    if (body.tier !== undefined) {
      sets.push('tier = ?')
      values.push(body.tier)
    }
    if (body.priority !== undefined) {
      sets.push('priority = ?')
      values.push(body.priority)
    }
    if (body.timeout_ms !== undefined) {
      sets.push('timeout_ms = ?')
      values.push(body.timeout_ms)
    }
    if (body.concurrency !== undefined) {
      sets.push('concurrency = ?')
      values.push(body.concurrency)
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }
    if (sets.length === 0) {
      throw badRequest('没有需要修改的字段')
    }

    app.db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return { ray: request.ray, item: toPayload(findChannel(id)) }
  })

  app.delete<{ Params: { id: string } }>('/channels/:id', async (request) => {
    const { id } = request.params
    findChannel(id)
    // keys / key_models / key_usage 由外键 ON DELETE CASCADE 连带清掉（db 已开 foreign_keys）
    app.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
    return { ray: request.ray, ok: true }
  })

  app.post<{ Params: { id: string } }>('/channels/:id/test', async (request) => {
    const channel = findChannel(request.params.id)

    // 「第一把可用 Key」= 池子里当前真的会被选中的那种状态
    const key = app.db
      .prepare(
        `SELECT * FROM keys
         WHERE channel_id = ? AND status = 'active'
           AND (cooldown_until IS NULL OR cooldown_until < ?)
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(channel.id, nowIso()) as { key_cipher: string } | undefined

    if (!key) {
      return {
        ray: request.ray,
        channel_id: channel.id,
        ok: false,
        status: null,
        latency_ms: 0,
        error: '该渠道下没有可用的 Key',
      }
    }

    const result = await probeModels(channel.base_url, decryptSecret(key.key_cipher))
    return { ray: request.ray, channel_id: channel.id, ...result }
  })
}
