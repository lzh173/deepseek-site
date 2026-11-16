import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ChannelRow, KeyModelRow, KeyRow, KeyStatus } from '../../db/types.ts'
import { decryptSecret, encryptSecret, maskSecret, randomId } from '../../lib/crypto.ts'
import { badRequest, notFound } from '../../lib/errors.ts'
import { nowIso, todayUtc } from '../../lib/time.ts'
import { probeModels } from './channels.ts'

/**
 * 管理端「账号池」页：Key 的批量导入、掩码列表、单条编辑、测试、重置与模型映射。
 *
 * 铁律：任何接口都不返回明文（GOAL.md §7.3），列表只给 secret_masked；
 * 需要真实 Key 的地方只有「单 Key 测试」这一处，解密后仅用于发一次上游请求。
 */

const ListQuery = z.object({
  channelId: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'cooling', 'disabled']).optional(),
})

/**
 * 批量导入：keys 既可是「一行一把」的整段文本，也可是数组。
 * label 给了就作为前缀，多把时自动加序号，保证同一批 Key 在列表里分得清。
 */
const BatchBody = z.object({
  channel_id: z.string().trim().min(1),
  keys: z.union([z.string().max(200_000), z.array(z.string().max(512)).max(500)]),
  label: z.string().trim().max(64).optional(),
  group_label: z.string().trim().max(64).nullable().optional(),
  weight: z.coerce.number().int().min(0).max(10_000).default(1),
  daily_quota: z.coerce.number().int().min(0).default(1_000),
})

/** 单条编辑只开放这几个字段：状态由池子的冷却/熔断逻辑自己管。 */
const UpdateBody = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  group_label: z.string().trim().max(64).nullable().optional(),
  weight: z.coerce.number().int().min(0).max(10_000).optional(),
  daily_quota: z.coerce.number().int().min(0).optional(),
})

/** key_models 全量替换：同一个 (public_model, upstream_model) 只保留一条。 */
const ModelsBody = z.object({
  models: z
    .array(
      z.object({
        public_model: z.string().trim().min(1).max(64),
        upstream_model: z.string().trim().min(1).max(128),
        weight: z.coerce.number().int().min(0).max(10_000).default(1),
        enabled: z.boolean().default(true),
      })
    )
    .max(500),
})

type KeyModelPayload = {
  public_model: string
  upstream_model: string
  weight: number
  enabled: boolean
}

type KeyPayload = {
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
  models: KeyModelPayload[]
}

const toModelPayload = (row: KeyModelRow): KeyModelPayload => ({
  public_model: row.public_model,
  upstream_model: row.upstream_model,
  weight: row.weight,
  enabled: row.enabled === 1,
})

/**
 * 列表只显示掩码。单行密文损坏（换过主密钥等）时退化成全掩码而不是让整页 500，
 * 管理员仍能看到这把 Key 并重置/删除它。
 */
const maskOf = (cipher: string): string => {
  try {
    return maskSecret(decryptSecret(cipher))
  } catch {
    return '••••'
  }
}

export const keyRoutes = async (app: FastifyInstance): Promise<void> => {
  const findKey = (id: string): KeyRow => {
    const row = app.db.prepare('SELECT * FROM keys WHERE id = ?').get(id) as KeyRow | undefined
    if (!row) {
      throw notFound('Key 不存在')
    }
    return row
  }

  const toPayload = (row: KeyRow): KeyPayload => {
    const usage = app.db
      .prepare('SELECT requests FROM key_usage WHERE key_id = ? AND day = ?')
      .get(row.id, todayUtc()) as { requests: number } | undefined
    const models = app.db
      .prepare(
        `SELECT * FROM key_models
         WHERE key_id = ?
         ORDER BY public_model ASC, upstream_model ASC`
      )
      .all(row.id) as KeyModelRow[]

    return {
      id: row.id,
      channel_id: row.channel_id,
      label: row.label,
      group_label: row.group_label,
      weight: row.weight,
      status: row.status,
      cooldown_until: row.cooldown_until,
      daily_quota: row.daily_quota,
      fail_count: row.fail_count,
      last_ok_at: row.last_ok_at,
      created_at: row.created_at,
      secret_masked: maskOf(row.key_cipher),
      used_today: usage?.requests ?? 0,
      models: models.map(toModelPayload),
    }
  }

  app.get('/keys', async (request) => {
    const parsed = ListQuery.safeParse(request.query)
    if (!parsed.success) {
      throw badRequest('查询参数不正确')
    }
    const query = parsed.data

    const where: string[] = []
    const values: string[] = []
    if (query.channelId) {
      where.push('channel_id = ?')
      values.push(query.channelId)
    }
    if (query.status) {
      where.push('status = ?')
      values.push(query.status)
    }

    const rows = app.db
      .prepare(
        `SELECT * FROM keys
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at ASC, id ASC`
      )
      .all(...values) as KeyRow[]

    return { ray: request.ray, items: rows.map(toPayload) }
  })

  app.post('/keys', async (request) => {
    const parsed = BatchBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('Key 参数不正确')
    }
    const body = parsed.data

    const channel = app.db.prepare('SELECT * FROM channels WHERE id = ?').get(body.channel_id) as
      | ChannelRow
      | undefined
    if (!channel) {
      throw notFound('渠道不存在')
    }

    // 一行一把：整段文本按行切，数组则逐项取，空行忽略
    const lines = typeof body.keys === 'string' ? body.keys.split(/\r?\n/) : body.keys
    const secrets = lines.map((line) => line.trim()).filter((line) => line.length > 0)

    if (secrets.length === 0) {
      throw badRequest('至少提供一把 Key')
    }
    if (secrets.length > 500) {
      throw badRequest('单次最多导入 500 把 Key')
    }

    const existing = app.db
      .prepare('SELECT COUNT(*) AS n FROM keys WHERE channel_id = ?')
      .get(channel.id) as { n: number }

    /**
     * 只导入一把且显式给了 label → 原样使用；否则在基础名后接「渠道内下一个序号」，
     * 保证批量粘贴进来的 Key 在列表里能一眼区分（label 只是展示用，不参与路由）。
     */
    const labelOf = (index: number): string => {
      if (body.label && body.label.length > 0 && secrets.length === 1) {
        return body.label
      }
      const base = body.label && body.label.length > 0 ? body.label : channel.name
      return `${base} #${existing.n + index + 1}`
    }

    const insert = app.db.prepare(
      `INSERT INTO keys (id, channel_id, key_cipher, label, group_label, weight, status,
                         cooldown_until, daily_quota, fail_count, last_ok_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, 0, NULL, ?)`
    )

    const ids: string[] = []
    const createdAt = nowIso()
    // 一个事务写完整批：中途失败不留下半批 Key
    app.db.transaction(() => {
      for (const [index, secret] of secrets.entries()) {
        const id = randomId('key')
        insert.run(
          id,
          channel.id,
          encryptSecret(secret),
          labelOf(index),
          body.group_label ?? null,
          body.weight,
          body.daily_quota,
          createdAt
        )
        ids.push(id)
      }
    })()

    const items = ids.map((id) => toPayload(findKey(id)))
    return { ray: request.ray, created: items.length, items }
  })

  app.patch<{ Params: { id: string } }>('/keys/:id', async (request) => {
    const row = findKey(request.params.id)
    const parsed = UpdateBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('Key 参数不正确')
    }
    const body = parsed.data

    const sets: string[] = []
    const values: (string | number | null)[] = []
    if (body.label !== undefined) {
      sets.push('label = ?')
      values.push(body.label)
    }
    if (body.group_label !== undefined) {
      sets.push('group_label = ?')
      values.push(body.group_label)
    }
    if (body.weight !== undefined) {
      sets.push('weight = ?')
      values.push(body.weight)
    }
    if (body.daily_quota !== undefined) {
      sets.push('daily_quota = ?')
      values.push(body.daily_quota)
    }
    if (sets.length === 0) {
      throw badRequest('没有需要修改的字段')
    }

    app.db.prepare(`UPDATE keys SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id)
    return { ray: request.ray, item: toPayload(findKey(row.id)) }
  })

  app.delete<{ Params: { id: string } }>('/keys/:id', async (request) => {
    const row = findKey(request.params.id)
    // key_models / key_usage / grants 均有 ON DELETE CASCADE 外键，随 Key 一起走
    app.db.prepare('DELETE FROM keys WHERE id = ?').run(row.id)
    return { ray: request.ray, ok: true }
  })

  app.post<{ Params: { id: string } }>('/keys/:id/test', async (request) => {
    const row = findKey(request.params.id)
    const channel = app.db.prepare('SELECT * FROM channels WHERE id = ?').get(row.channel_id) as
      | ChannelRow
      | undefined
    if (!channel) {
      throw notFound('Key 所属渠道不存在')
    }

    // 这里唯一一次解密；只在内存里活一次，不写日志、不回传
    const secret = decryptSecret(row.key_cipher)
    const result = await probeModels(channel.base_url, secret)

    // 手工测试不动 Key 状态：健康判定由真实流量（pool/reportKey）驱动，避免人工点测互相打架
    return { ray: request.ray, key_id: row.id, ...result }
  })

  app.post<{ Params: { id: string } }>('/keys/:id/reset', async (request) => {
    const row = findKey(request.params.id)
    app.db
      .prepare(
        `UPDATE keys
         SET status = 'active', cooldown_until = NULL, fail_count = 0
         WHERE id = ?`
      )
      .run(row.id)
    return { ray: request.ray, item: toPayload(findKey(row.id)) }
  })

  app.put<{ Params: { id: string } }>('/keys/:id/models', async (request) => {
    const row = findKey(request.params.id)
    const parsed = ModelsBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('模型映射参数不正确')
    }

    // 公开模型必须先存在，否则映射永远匹配不到任何请求，纯属脏数据
    const knownModels = new Set(
      (app.db.prepare('SELECT id FROM models').all() as { id: string }[]).map((item) => item.id)
    )
    const unknown = [...new Set(parsed.data.models.map((item) => item.public_model))].filter(
      (name) => !knownModels.has(name)
    )
    if (unknown.length > 0) {
      throw badRequest(`公开模型不存在：${unknown.join('、')}`)
    }

    // 主键是 (key_id, upstream_model, public_model)，同一组合重复出现只留最后一条
    const unique = new Map<string, (typeof parsed.data.models)[number]>()
    for (const item of parsed.data.models) {
      unique.set(`${item.public_model}\u0000${item.upstream_model}`, item)
    }

    const insert = app.db.prepare(
      `INSERT INTO key_models (key_id, public_model, upstream_model, weight, enabled)
       VALUES (?, ?, ?, ?, ?)`
    )
    app.db.transaction(() => {
      // 全量替换：先清空该 Key 的全部映射，再按请求重建
      app.db.prepare('DELETE FROM key_models WHERE key_id = ?').run(row.id)
      for (const item of unique.values()) {
        insert.run(
          row.id,
          item.public_model,
          item.upstream_model,
          item.weight,
          item.enabled ? 1 : 0
        )
      }
    })()

    return { ray: request.ray, item: toPayload(findKey(row.id)) }
  })
}
