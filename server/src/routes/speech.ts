import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { badRequest, serverBusy, tooLarge } from '../lib/errors.ts'
import { requireUser } from '../plugins/auth.ts'
import { HttpError } from '../lib/errors.ts'

/** 用户明确选择了浏览器实现：用 501 让前端走本地的 Web Speech 兜底（见 services/api/speech.ts） */
class NotOfficialError extends HttpError {
  constructor(message: string) {
    super(501, 'internal', message)
  }
}
import { officialPost, requireOfficialTools } from '../caps/official.ts'
import { isDisabled, wantsBrowser } from '../caps/prefs.ts'

/**
 * 语音能力：把 DeepSeek 官方 TTS / ASR 搬到后端。
 *
 * 前端（src/services/api/speech.ts）的约定：
 * - POST /api/speech/asr  multipart 字段 file → { text }
 * - POST /api/speech/tts  JSON { text, voice_id, format } → 音频字节流（裸 PCM / WAV）
 * 服务端未实现时前端会自动退回浏览器 Web Speech，所以这里的失败必须是**明确的 4xx/5xx**，
 * 不能返回 200 + 空内容。
 */

const ASR_MAX_BYTES = 8 * 1024 * 1024
const TTS_MAX_CHARS = 10_000

const TtsBody = z.object({
  text: z.string().min(1).max(TTS_MAX_CHARS),
  voice_id: z.enum(['stella', 'tide']).default('stella'),
  format: z.enum(['pcm', 'wav']).default('pcm'),
  filter_markdown: z.boolean().default(true),
})

export const speechRoutes = async (app: FastifyInstance): Promise<void> => {
  /** 语音识别：转发到官方 /v1/tools/asr */
  app.post('/speech/asr', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    // 用户在设置里选了「浏览器」：直接 501，让前端走本地兜底，不花官方的钱
    if (wantsBrowser(app, user, 'asr') || isDisabled(app, user, 'asr')) {
      throw new NotOfficialError('ASR 已设置为浏览器实现')
    }
    const credential = requireOfficialTools(app, user, 'asr')

    const file = await request.file().catch(() => null)
    if (!file) {
      throw badRequest('缺少 file 字段（multipart/form-data）')
    }
    const buffer = await file.toBuffer()
    if (buffer.byteLength === 0) {
      throw badRequest('音频为空')
    }
    if (buffer.byteLength > ASR_MAX_BYTES) {
      throw tooLarge('音频超过 8 MB')
    }

    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: file.mimetype || 'audio/wav' }),
      file.filename || 'recording.wav'
    )

    const response = await fetch(`${credential.baseUrl}/v1/tools/asr`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.secret}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    }).catch(() => null)

    if (!response) {
      throw serverBusy('语音识别服务不可达')
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      request.log.warn({ ray: request.ray, status: response.status }, '官方 ASR 失败')
      throw serverBusy(detail.slice(0, 120) || `语音识别失败（HTTP ${response.status}）`)
    }

    const payload = (await response.json()) as { text?: string }
    return { ray: request.ray, text: typeof payload.text === 'string' ? payload.text : '' }
  })

  /** 语音合成：转发到官方 /v1/tools/tts，音频边合成边回传 */
  app.post('/speech/tts', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user!
    if (wantsBrowser(app, user, 'tts') || isDisabled(app, user, 'tts')) {
      throw new NotOfficialError('TTS 已设置为浏览器实现')
    }
    const credential = requireOfficialTools(app, user, 'tts')

    const parsed = TtsBody.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('合成参数不正确')
    }
    const body = parsed.data

    const response = await officialPost(
      credential,
      '/v1/tools/tts',
      {
        text: body.text,
        voice_id: body.voice_id,
        format: body.format,
        filter_markdown: body.filter_markdown,
      },
      120_000,
      request.raw.destroyed ? undefined : undefined
    ).catch(() => null)

    if (!response) {
      throw serverBusy('语音合成服务不可达')
    }
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      request.log.warn({ ray: request.ray, status: response.status }, '官方 TTS 失败')
      throw serverBusy(detail.slice(0, 120) || `语音合成失败（HTTP ${response.status}）`)
    }

    void reply
      .header('content-type', body.format === 'wav' ? 'audio/wav' : 'audio/L16')
      .header('cache-control', 'no-store')

    // 直接把上游的字节流交给客户端（Fastify 支持返回 ReadableStream）
    return reply.send(response.body)
  })
}
