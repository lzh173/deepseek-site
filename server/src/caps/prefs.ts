import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { badRequest } from '../lib/errors.ts'
import type { SessionUser } from '../lib/user.ts'

/**
 * 能力来源偏好：用户可以让某项能力「自动 / 强制走官方 / 强制走浏览器 / 关闭」。
 *
 * 为什么要做成偏好而不是纯自动：官方能力按次计费（TTS 每万字符 1.5 元、OCR 每千页 1.5 元），
 * 管理员可能希望朗读用浏览器免费合成、只把 OCR 留给官方；免费账号则根本没有官方能力可选。
 * 存 `user_prefs`（key = capability.prefs），跨设备生效。
 */

export type CapabilitySource = 'auto' | 'server' | 'browser' | 'off'

export type CapabilityPrefs = {
  search: 'auto' | 'server' | 'off'
  fetch: 'auto' | 'server' | 'off'
  tts: CapabilitySource
  asr: CapabilitySource
  ocr: 'auto' | 'server' | 'off'
  document: 'auto' | 'server' | 'off'
}

const DEFAULTS: CapabilityPrefs = {
  search: 'auto',
  fetch: 'auto',
  tts: 'auto',
  asr: 'auto',
  ocr: 'auto',
  document: 'auto',
}

const PrefsBody = z.object({
  search: z.enum(['auto', 'server', 'off']).optional(),
  fetch: z.enum(['auto', 'server', 'off']).optional(),
  tts: z.enum(['auto', 'server', 'browser']).optional(),
  asr: z.enum(['auto', 'server', 'browser']).optional(),
  ocr: z.enum(['auto', 'server', 'off']).optional(),
  document: z.enum(['auto', 'server', 'off']).optional(),
})

const PREFS_KEY = 'capability.prefs'

export const readCapabilityPrefs = (
  app: FastifyInstance,
  userId: string
): CapabilityPrefs => {
  const row = app.db
    .prepare('SELECT value_json FROM user_prefs WHERE user_id = ? AND key = ?')
    .get(userId, PREFS_KEY) as { value_json: string } | undefined
  if (!row) {
    return { ...DEFAULTS }
  }
  try {
    const parsed = JSON.parse(row.value_json) as Partial<CapabilityPrefs>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export const writeCapabilityPrefs = (
  app: FastifyInstance,
  userId: string,
  patch: Partial<CapabilityPrefs>
): CapabilityPrefs => {
  const next = { ...readCapabilityPrefs(app, userId), ...patch }
  app.db
    .prepare(
      `INSERT INTO user_prefs (user_id, key, value_json) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json`
    )
    .run(userId, PREFS_KEY, JSON.stringify(next))
  return next
}

/** 该用户对某项能力的选择（已叠加默认值） */
export const capabilityPref = (
  app: FastifyInstance,
  user: SessionUser,
  key: keyof CapabilityPrefs
): CapabilityPrefs[keyof CapabilityPrefs] => readCapabilityPrefs(app, user.id)[key]

/** 用户明确要求「用浏览器」时，服务端就不该再花官方的钱 */
export const wantsBrowser = (
  app: FastifyInstance,
  user: SessionUser,
  key: keyof CapabilityPrefs
): boolean => capabilityPref(app, user, key) === 'browser'

/** 用户关掉了这项能力 */
export const isDisabled = (
  app: FastifyInstance,
  user: SessionUser,
  key: keyof CapabilityPrefs
): boolean => capabilityPref(app, user, key) === 'off'

export const capabilityPrefsRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/capabilities/prefs', async (request) => ({
    ray: request.ray,
    prefs: readCapabilityPrefs(app, request.user!.id),
  }))

  app.put('/capabilities/prefs', async (request) => {
    const parsed = PrefsBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('能力偏好参数不正确')
    }
    const prefs = writeCapabilityPrefs(app, request.user!.id, parsed.data)
    return { ray: request.ray, prefs }
  })
}
