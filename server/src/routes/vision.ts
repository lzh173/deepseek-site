/**
 * POST /api/vision/describe：当前模型看不了图时，借一个支持视觉的公开模型先「看图说话」，
 * 把图片转成文本再交给目标模型（GOAL.md §9 #7、§10）。
 *
 * 边界：
 * - 只接受图片；单张上限 10 MB（上传允许 20 MB，但转述要整块读进内存并转 base64，这里卡得更严）；
 * - 视觉模型从 models 里按 caps_json.vision 挑，且必须落在该用户的授权集合内（free / admin / grants），
 *   授权边界由 pool.pickKey 保证，这里不自己算 Key；
 * - 上游失败统一回 5xx + ray，并按结果回写 Key 状态；具体原因只进日志与 usage_log。
 */

import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { fetch, type Response } from 'undici'
import { z } from 'zod'
import type { ModelRow } from '../db/types.ts'
import { HttpError, badRequest, serverBusy, tooLarge, unauthorized } from '../lib/errors.ts'
import { nowIso } from '../lib/time.ts'
import type { SessionUser } from '../lib/user.ts'
import { requireUser } from '../plugins/auth.ts'
import { isModelAllowed, pickKey, reportKey, type PoolPick } from '../pool/index.ts'
import { canAccessFile, fileDiskPath, findFile, isSha256 } from '../storage/files.ts'

/** 单张图片上限：再大就不该整块进内存。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 没传 question 时让视觉模型做的事：正文优先，同时照顾图内文字、图表与界面元素。 */
const DEFAULT_QUESTION = '请详细描述这张图片的内容，包括文字、图表与界面元素'

/** 上游失败的对外话术：前端只读 error.message，5xx 会自动出现「重试」（GOAL.md §12.2）。 */
const UPSTREAM_BUSY = '服务器繁忙，请稍后再试'

/** 错误信息里最多带多少上游正文，避免把整段报错塞进日志。 */
const MAX_DETAIL = 200

const MB = 1024 * 1024

/** 文件不存在（含 id 非法、无读权限、磁盘原件丢失）：文案必须命中前端正则（GOAL.md §6.4）。 */
const missingFile = (): HttpError =>
  badRequest('file_ids do not exist or are not created under your account')

// ---------- 入参校验 ----------

const bodySchema = z.object({
  file_id: z.string().trim().min(1).max(128),
  question: z.string().trim().max(2000).optional(),
})

/** 校验失败按 400 报；前端只会看到 error.message。 */
const parseBody = (raw: unknown): { fileId: string; question: string } => {
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') ?? ''
    const reason = issue?.message ?? '格式不正确'
    throw badRequest(`请求体不合法${where === '' ? '' : `（${where}）`}：${reason}`)
  }
  const question = parsed.data.question ?? ''
  return {
    fileId: parsed.data.file_id,
    question: question === '' ? DEFAULT_QUESTION : question,
  }
}

// ---------- 读原件 ----------

type ImagePayload = {
  /** 裸图片 MIME，写进 data URL */
  mime: string
  base64: string
}

/** data URL 的 MIME 必须是裸类型（不带参数）；异常值退回 png。 */
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/i

const normalizeImageMime = (mime: string): string => (IMAGE_MIME_RE.test(mime) ? mime : 'image/png')

/**
 * 读原图：先确认库里有记录且当前用户可读，再核对磁盘原件大小，最后整块读入并转 base64。
 * 归属规则见 storage/files.ts 头部注释（被会话引用时只认属主）。
 */
const readImage = async (
  app: FastifyInstance,
  user: SessionUser,
  fileId: string
): Promise<ImagePayload> => {
  if (!isSha256(fileId)) {
    throw missingFile()
  }
  const row = findFile(app.db, fileId)
  if (!row || !canAccessFile(app.db, user.id, fileId)) {
    throw missingFile()
  }
  if (!row.mime.startsWith('image/')) {
    throw badRequest('只能转述图片文件')
  }

  const diskPath = fileDiskPath(fileId)
  const stat = await fs.promises.stat(diskPath).catch(() => null)
  if (!stat?.isFile()) {
    // 记录还在但磁盘丢了：与 files 路由一致，提示「文件不存在」
    throw missingFile()
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw tooLarge(`图片超过 ${MAX_IMAGE_BYTES / MB} MB 上限，无法转述`)
  }

  const bytes = await fs.promises.readFile(diskPath).catch(() => null)
  if (!bytes) {
    throw missingFile()
  }
  if (bytes.byteLength === 0) {
    throw badRequest('图片内容为空，无法转述')
  }
  return { mime: normalizeImageMime(row.mime), base64: bytes.toString('base64') }
}

// ---------- 挑选视觉模型 ----------

/** caps_json 里显式 vision: true 才算视觉模型；坏 JSON 一律按不支持处理。 */
const supportsVision = (row: ModelRow): boolean => {
  try {
    const raw = JSON.parse(row.caps_json || '{}') as { vision?: unknown }
    return raw.vision === true
  } catch {
    return false
  }
}

/**
 * 挑一个「用户可用且还有可用 Key」的视觉模型。
 * tier 升序让 free 排前面（普通用户优先走免费兜底）；付费模型只有在授权集合内才会进候选，
 * 越界的模型连列表都不出现，更不会被这里选中（GOAL.md §8.2）。
 * 某个模型的 Key 全部冷却时换下一个，全都没有可用 Key 才 503 server_busy。
 */
const pickVisionModel = async (app: FastifyInstance, user: SessionUser): Promise<PoolPick> => {
  const rows = app.db
    .prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY tier ASC, id ASC')
    .all() as ModelRow[]

  for (const row of rows) {
    if (!supportsVision(row) || !isModelAllowed(app, user, row)) {
      continue
    }
    try {
      return await pickKey(app, { publicModel: row.id, user })
    } catch (error) {
      // 该模型暂时没有可用 Key（冷却 / 配额耗尽）：换下一个视觉模型；
      // 其余错误（参数、授权）不是「换一个模型」能解决的，直接抛出去。
      if (!(error instanceof HttpError) || error.status !== 503) {
        throw error
      }
    }
  }
  throw serverBusy('没有可用的视觉模型')
}

// ---------- 上游调用 ----------

type UpstreamOutcome =
  | { ok: true; description: string; inTok: number; outTok: number }
  | {
      ok: false
      /** 上游 HTTP 状态；网络层失败与「空内容」用 undefined / 502 */
      status?: number
      /** 只进日志与 usage_log 的技术细节 */
      detail: string
      /** true 表示暂时性故障（超时、429、5xx），对外回 503 让用户重试 */
      temporary: boolean
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const truncate = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text

/** content 允许是纯文本，也允许是文本块数组（部分中转站这么回）。 */
const readContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
}

/** 从 OpenAI 形状的响应里取正文与 token 用量；缺字段一律按 0 / 空串处理。 */
const readUpstream = (payload: unknown): { description: string; inTok: number; outTok: number } => {
  if (!isRecord(payload)) {
    return { description: '', inTok: 0, outTok: 0 }
  }
  const choices = payload.choices
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined
  const message = isRecord(first) ? first.message : undefined
  const content = isRecord(message) ? message.content : undefined
  const usage = isRecord(payload.usage) ? payload.usage : {}

  return {
    description: readContent(content),
    inTok: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    outTok: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
  }
}

/**
 * 非流式请求一次上游：POST {baseUrl}/chat/completions，图片以 data URL 内联。
 * 失败不抛异常，交给调用方回写 Key 并决定状态码。
 */
const describeOnce = async (
  pick: PoolPick,
  image: ImagePayload,
  question: string
): Promise<UpstreamOutcome> => {
  const dataUrl = `data:${image.mime};base64,${image.base64}`
  let response: Response
  try {
    response = await fetch(`${pick.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pick.secret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: pick.upstreamModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: question },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      // 与聊天共用渠道超时；超时即视为暂时性故障
      signal: AbortSignal.timeout(pick.timeoutMs),
    })
  } catch (error) {
    return { ok: false, detail: `连接上游失败：${errorText(error)}`, temporary: true }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const detail = body.trim() === '' ? '' : `：${truncate(body.trim())}`
    return {
      ok: false,
      status: response.status,
      detail: `上游返回 ${response.status}${detail}`,
      // 429 / 5xx 是暂时性的；4xx 多是我们自己的请求形状问题，重试无用
      temporary: response.status === 429 || response.status >= 500,
    }
  }

  const payload: unknown = await response.json().catch(() => null)
  const parsed = readUpstream(payload)
  if (parsed.description === '') {
    return { ok: false, status: 502, detail: '上游没有返回可用的转述内容', temporary: true }
  }
  return { ok: true, ...parsed }
}

// ---------- usage_log ----------

/** 与 chat.ts 同一张表：后台可以按 ray 反查这次转述走了哪把 Key（GOAL.md §12.1）。 */
const recordUsage = (
  app: FastifyInstance,
  input: {
    ray: string
    user: SessionUser
    pick: PoolPick | null
    status: string
    inTok: number
    outTok: number
    ms: number
    /** 失败原因；成功为 null */
    err: string | null
  }
): void => {
  try {
    app.db
      .prepare(
        `INSERT OR REPLACE INTO usage_log
           (ray, ts, user_id, channel_id, key_id, public_model, upstream_model,
            in_tok, out_tok, ms, status, err)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.ray,
        nowIso(),
        input.user.id,
        input.pick?.channelId ?? null,
        input.pick?.keyId ?? null,
        input.pick?.publicModel ?? null,
        input.pick?.upstreamModel ?? null,
        input.inTok,
        input.outTok,
        input.ms,
        input.status,
        input.status === 'ok' ? null : input.err
      )
  } catch (error) {
    // 日志失败不能影响已经拿到的描述
    app.log.warn({ err: error, ray: input.ray }, 'usage_log 写入失败')
  }
}

// ---------- 路由 ----------

export const visionRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/vision/describe', { preHandler: requireUser }, async (request) => {
    const user = request.user
    if (!user) {
      throw unauthorized()
    }
    const ray = request.ray
    const { fileId, question } = parseBody(request.body)

    const startedAt = Date.now()
    let pick: PoolPick | null = null
    let status = 'error'
    let inTok = 0
    let outTok = 0
    let detail: string | null = null

    try {
      // 先验文件再挑 Key：文件本身不合法时不该白占一把 Key 的额度
      const image = await readImage(app, user, fileId)
      pick = await pickVisionModel(app, user)

      const outcome = await describeOnce(pick, image, question)
      if (!outcome.ok) {
        // 回写失败结果：401/403 会禁用这把 Key，429/5xx/超时进入冷却（pool.reportKey）
        reportKey(app, pick, { ok: false, status: outcome.status, error: outcome.detail })
        detail = outcome.detail
        status = outcome.temporary ? 'busy' : 'error'
        request.log.warn(
          { ray, model: pick.publicModel, status: outcome.status, err: outcome.detail },
          '图片转述上游失败'
        )
        throw outcome.temporary
          ? serverBusy()
          : new HttpError(502, 'upstream_unavailable', UPSTREAM_BUSY)
      }

      reportKey(app, pick, {
        ok: true,
        ms: Date.now() - startedAt,
        inTok: outcome.inTok,
        outTok: outcome.outTok,
      })
      inTok = outcome.inTok
      outTok = outcome.outTok
      status = 'ok'
      return { ray, description: outcome.description, model: pick.publicModel }
    } catch (error) {
      detail = detail ?? (error instanceof Error ? error.message : String(error))
      if (error instanceof HttpError && error.status === 503) {
        status = 'busy'
      }
      throw error
    } finally {
      recordUsage(app, {
        ray,
        user,
        pick,
        status,
        inTok,
        outTok,
        ms: Date.now() - startedAt,
        err: detail,
      })
    }
  })
}
