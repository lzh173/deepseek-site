import type { FastifyInstance } from 'fastify'
import { decryptSecret } from '../lib/crypto.ts'
import { env } from '../env.ts'
import type { SessionUser } from '../lib/user.ts'
import { forbidden, serverBusy } from '../lib/errors.ts'

/**
 * DeepSeek 官方「工具类」能力：Search / Fetch / TTS / ASR / OCR / 文件解析。
 *
 * 这些能力**按官方账号计费**，与对话用的是哪个模型无关。所以：
 * - 免费账号（role = user 且没有 grants）不开放：它们的额度应该走免费渠道；
 * - 授权账号（有 grants）和 admin 开放，由 env 开关与角色共同决定。
 *
 * 凭证统一从「官方渠道」（official = 1，或 base_url 指向 api.deepseek.com）里的
 * 可用 Key 取；换 Key 时只影响这里，不影响渠道池。
 */

export type OfficialCapability = 'search' | 'fetch' | 'tts' | 'asr' | 'ocr' | 'document'

export type OfficialCredential = {
  baseUrl: string
  secret: string
  keyId: string
  channelId: string
}

const pickCredential = (app: FastifyInstance): OfficialCredential | null => {
  const rows = app.db
    .prepare(
      `SELECT c.id AS channel_id, c.base_url, k.id AS key_id, k.key_cipher
       FROM keys k JOIN channels c ON c.id = k.channel_id
       WHERE c.enabled = 1 AND k.status = 'active'
         AND (c.official = 1 OR c.base_url LIKE '%api.deepseek.com%')
       ORDER BY c.official DESC, c.priority ASC
       LIMIT 1`
    )
    .all() as { channel_id: string; base_url: string; key_id: string; key_cipher: string }[]

  const row = rows[0]
  if (!row) {
    return null
  }
  try {
    return {
      baseUrl: (env.RAY_OFFICIAL_BASE_URL ?? row.base_url).replace(/\/+$/, ''),
      secret: decryptSecret(row.key_cipher),
      channelId: row.channel_id,
      keyId: row.key_id,
    }
  } catch {
    return null
  }
}

/** 官方能力是否已配置（有可用官方 Key） */
export const officialCredential = (app: FastifyInstance): OfficialCredential | null =>
  pickCredential(app)

/** 全局开关：RAY_OFFICIAL_TOOLS 设为 "0" 可以整体关掉官方工具能力 */
const toolsEnabled = (): boolean => env.RAY_OFFICIAL_TOOLS !== '0'

/**
 * 该用户能否使用官方能力。
 *
 * - admin：默认可以（可用 RAY_OFFICIAL_TOOLS_FOR 收窄，见下）
 * - 普通用户：必须被授权过（grants 里有记录），否则只能用免费渠道
 */
export const canUseOfficialTools = (
  app: FastifyInstance,
  user: SessionUser,
  _capability: OfficialCapability
): boolean => {
  if (!toolsEnabled()) {
    return false
  }
  const policy = env.RAY_OFFICIAL_TOOLS_FOR ?? 'admin,authorized'
  const allowed = new Set(policy.split(',').map((item) => item.trim()))

  if (user.role === 'admin') {
    return allowed.has('admin') || allowed.has('all')
  }
  if (!allowed.has('authorized') && !allowed.has('all')) {
    return false
  }
  // 被授权过任意模型即视为「授权账号」
  const granted = app.db
    .prepare(
      `SELECT 1 FROM grants WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
    )
    .get(user.id, new Date().toISOString())
  return Boolean(granted)
}

/** 能力不可用时统一抛 403，文案明确指向「需要授权」 */
export const requireOfficialTools = (
  app: FastifyInstance,
  user: SessionUser,
  capability: OfficialCapability
): OfficialCredential => {
  if (!canUseOfficialTools(app, user, capability)) {
    throw forbidden('该能力仅对管理员与授权账号开放')
  }
  const credential = pickCredential(app)
  if (!credential) {
    throw serverBusy('未配置官方 API Key，无法使用该能力')
  }
  return credential
}

/** 组装请求 URL */
export const officialUrl = (credential: OfficialCredential, path: string): string =>
  `${credential.baseUrl}${path}`

/** 带鉴权的 JSON POST */
export const officialPost = async (
  credential: OfficialCredential,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> => {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) {
    signals.push(signal)
  }
  return fetch(officialUrl(credential, path), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
}
