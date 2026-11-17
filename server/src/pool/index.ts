import type { FastifyInstance } from 'fastify'
import type { ChannelKind, ModelRow } from '../db/types.ts'
import { decryptSecret } from '../lib/crypto.ts'
import { serverBusy } from '../lib/errors.ts'
import { addSeconds, nowIso, todayUtc } from '../lib/time.ts'
import type { SessionUser } from '../lib/user.ts'

/** 一次路由的结果：足够发起一次上游请求的全部信息。 */
export type PoolPick = {
  keyId: string
  channelId: string
  channelKind: ChannelKind
  baseUrl: string
  secret: string
  publicModel: string
  upstreamModel: string
  timeoutMs: number
}

/** 上游调用的结果，用于回写 Key 状态。 */
export type PoolOutcome =
  | { ok: true; ms: number; inTok?: number; outTok?: number }
  | { ok: false; status?: number; error: string; retryable?: boolean }

type CandidateRow = {
  key_id: string
  upstream_model: string
  weight: number
  daily_quota: number
  key_cipher: string
  channel_id: string
  kind: ChannelKind
  base_url: string
  timeout_ms: number
  priority: number
  used_today: number | null
}

const CANDIDATE_SQL = `
  SELECT km.key_id, km.upstream_model, km.weight,
         k.daily_quota, k.key_cipher, k.channel_id,
         c.kind, c.base_url, c.timeout_ms, c.priority,
         (SELECT u.requests FROM key_usage u WHERE u.key_id = km.key_id AND u.day = ?) AS used_today
  FROM key_models km
  JOIN keys k ON k.id = km.key_id
  JOIN channels c ON c.id = k.channel_id
  WHERE km.public_model = ?
    AND km.enabled = 1
    AND k.status = 'active'
    AND (k.cooldown_until IS NULL OR k.cooldown_until < ?)
    AND c.enabled = 1
`

/** 取模型定义；不存在或未启用直接 404 语义。 */
export const getModel = (app: FastifyInstance, publicModel: string): ModelRow => {
  const row = app.db
    .prepare('SELECT * FROM models WHERE id = ? AND enabled = 1')
    .get(publicModel) as ModelRow | undefined
  if (!row) {
    throw serverBusy('模型不存在或已停用')
  }
  return row
}

/** 该用户对某模型是否被授权（free 全员 / admin 全量 / 普通用户看 grants）。 */
export const isModelAllowed = (
  app: FastifyInstance,
  user: SessionUser,
  model: ModelRow
): boolean => {
  if (model.tier === 'free' || user.role === 'admin') {
    return true
  }
  const now = nowIso()
  const hit = app.db
    .prepare(
      `SELECT 1 FROM grants
       WHERE user_id = ? AND model_id = ? AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    )
    .get(user.id, model.id, now)
  return Boolean(hit)
}

/** 普通用户的付费模型只能走 grants 里授权的 Key。 */
const grantedKeyIds = (app: FastifyInstance, userId: string, modelId: string): Set<string> => {
  const rows = app.db
    .prepare(
      `SELECT key_id FROM grants
       WHERE user_id = ? AND model_id = ? AND (expires_at IS NULL OR expires_at > ?)`
    )
    .all(userId, modelId, nowIso()) as { key_id: string }[]
  return new Set(rows.map((row) => row.key_id))
}

/**
 * 选一把 Key。规则见 GOAL.md §7.2：
 * 最闲优先（used_today / daily_quota 升序）→ 渠道优先级 → 权重。
 * 授权集合是硬边界：普通用户只在 grants 授权的 Key 里做故障转移。
 */
export const pickKey = async (
  app: FastifyInstance,
  input: { publicModel: string; user: SessionUser }
): Promise<PoolPick> => {
  const model = getModel(app, input.publicModel)
  const onlyKeys =
    model.tier === 'paid' && input.user.role !== 'admin'
      ? grantedKeyIds(app, input.user.id, model.id)
      : null

  if (onlyKeys && onlyKeys.size === 0) {
    throw serverBusy('该模型未授权')
  }

  const day = todayUtc()
  const rows = app.db.prepare(CANDIDATE_SQL).all(day, model.id, nowIso()) as CandidateRow[]

  const candidates = rows
    .filter((row) => (onlyKeys ? onlyKeys.has(row.key_id) : true))
    .filter((row) => (row.used_today ?? 0) < row.daily_quota)
    .sort((a, b) => {
      const ratioA = (a.used_today ?? 0) / Math.max(a.daily_quota, 1)
      const ratioB = (b.used_today ?? 0) / Math.max(b.daily_quota, 1)
      if (ratioA !== ratioB) return ratioA - ratioB
      if (a.priority !== b.priority) return a.priority - b.priority
      return b.weight - a.weight
    })

  const first = candidates[0]
  if (!first) {
    throw serverBusy('没有可用 Key（全部冷却或额度耗尽）')
  }

  return {
    keyId: first.key_id,
    channelId: first.channel_id,
    channelKind: first.kind,
    baseUrl: first.base_url.replace(/\/+$/, ''),
    secret: decryptSecret(first.key_cipher),
    publicModel: model.id,
    upstreamModel: first.upstream_model,
    timeoutMs: first.timeout_ms,
  }
}

/** 回写调用结果：用量、冷却、熔断。 */
export const reportKey = (app: FastifyInstance, pick: PoolPick, outcome: PoolOutcome): void => {
  const day = todayUtc()

  if (outcome.ok) {
    app.db
      .prepare(
        `INSERT INTO key_usage (key_id, day, requests, tokens) VALUES (?, ?, 1, ?)
         ON CONFLICT(key_id, day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens`
      )
      .run(pick.keyId, day, (outcome.inTok ?? 0) + (outcome.outTok ?? 0))
    app.db
      .prepare('UPDATE keys SET fail_count = 0, last_ok_at = ? WHERE id = ?')
      .run(nowIso(), pick.keyId)
    return
  }

  const row = app.db.prepare('SELECT fail_count FROM keys WHERE id = ?').get(pick.keyId) as
    | { fail_count: number }
    | undefined
  const failCount = (row?.fail_count ?? 0) + 1
  const status = outcome.status

  if (status === 401 || status === 403) {
    app.db
      .prepare(
        "UPDATE keys SET status = 'disabled', fail_count = ?, last_ok_at = last_ok_at WHERE id = ?"
      )
      .run(failCount, pick.keyId)
    return
  }

  // 429 多为「每秒请求数」限流，恢复很快，用较短的退避；
  // 其他失败（5xx / 网络）给 30 秒，避免反复打到坏 Key 上。
  const cooldownSeconds = status === 429 ? Math.min(15 * 2 ** (failCount - 1), 300) : 30

  app.db
    .prepare(`UPDATE keys SET fail_count = ?, status = 'cooling', cooldown_until = ? WHERE id = ?`)
    .run(failCount, addSeconds(cooldownSeconds), pick.keyId)
}

/** 冷却结束后把 cooling 的 Key 拉回 active；由定时任务调用。 */
export const reviveCoolingKeys = (app: FastifyInstance): void => {
  app.db
    .prepare(
      `UPDATE keys SET status = 'active', fail_count = 0
       WHERE status = 'cooling' AND cooldown_until IS NOT NULL AND cooldown_until <= ?`
    )
    .run(nowIso())
}
