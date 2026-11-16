import type { FastifyInstance } from 'fastify'
import { request } from 'undici'
import { z } from 'zod'
import type { ChannelRow } from '../../db/types.ts'
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
const PROBE_TIMEOUT_MS = 5_000

/** 探活结果。失败不是异常，而是这个结构的一部分。 */
export type ProbeResult = {
  ok: boolean
  /** 上游 HTTP 状态码；连不上或超时时为 null。 */
  status: number | null
  latency_ms: number
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
 * GET {base_url}/models 探活；keys.ts 的单 Key 测试复用同一实现，故导出。
 * secret 为 null 时不带鉴权头（ollama 这类本地渠道）。
 */
export const probeModels = async (baseUrl: string, secret: string | null): Promise<ProbeResult> => {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const started = Date.now()
  try {
    const response = await request(url, {
      method: 'GET',
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // 不读完响应体，连接不会归还连接池；这里只关心状态码，读完丢掉
    await response.body.dump()
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      latency_ms: Date.now() - started,
    }
  } catch (error) {
    // 探活失败本就是预期结果之一：转成结构化返回值给前端展示，不是吞异常
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
      error: describeProbeError(error),
    }
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
  kind: z.enum(['openai', 'anthropic', 'gemini', 'ollama']),
  base_url: BaseUrl,
  tier: z.enum(['paid', 'free']),
  priority: z.coerce.number().int().min(0).max(10_000).default(100),
  timeout_ms: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  concurrency: z.coerce.number().int().min(1).max(64).default(4),
  enabled: z.boolean().default(true),
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
  const findChannel = (id: string): ChannelRow => {
    const row = app.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as
      | ChannelRow
      | undefined
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

    app.db
      .prepare(
        `INSERT INTO channels (id, name, kind, base_url, tier, priority, timeout_ms, concurrency, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        body.name,
        body.kind,
        // 末尾斜杠统一去掉，探活与上游调用都靠拼 path，避免出现 //
        body.base_url.replace(/\/+$/, ''),
        body.tier,
        body.priority,
        body.timeout_ms,
        body.concurrency,
        body.enabled ? 1 : 0,
        nowIso()
      )

    return { ray: request.ray, item: toPayload(findChannel(id)) }
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
