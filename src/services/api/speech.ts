import { ApiError, apiUrl, request } from './client.js'

/**
 * 语音接口（BFF）：
 * - ASR：POST /api/speech/asr，multipart 上传 WAV / Ogg Opus，一次返回全文
 * - TTS：POST /api/speech/tts，返回音频字节流（产出首帧后即返回 200）
 * 鉴权用同源 Cookie。
 *
 * GOAL.md A-08：MVP 阶段 BFF 不实现这两个路由（404 或占位 501），前端改用浏览器
 * Web Speech 兜底。这里把「服务端未实现」从普通失败里单独拎出来
 * （SpeechUnsupportedError），调用方判断一次就能决定走哪条链路；其余错误保持原样。
 */
const SPEECH_BASE_URL = apiUrl('/speech')

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** 探测最多等这么久；超时按「没探出来」处理，不把首次点击卡住 */
const PROBE_TIMEOUT_MS = 3000

/** 服务端语音接口未实现：路由不存在（404）或占位返回 501。 */
export class SpeechUnsupportedError extends Error {
  constructor(readonly status: number) {
    super(`speech endpoint is not implemented (HTTP ${status})`)
    this.name = 'SpeechUnsupportedError'
  }
}

/** 是否是「服务端未实现」；只在 404 / 501 时成立，网络错误与其它状态码都不算。 */
export const isSpeechUnsupported = (error: unknown): boolean =>
  error instanceof SpeechUnsupportedError ||
  (error instanceof ApiError && (error.status === 404 || error.status === 501))

/** 发请求，并把 404 / 501 换成 SpeechUnsupportedError；其余错误原样抛出。 */
const requestSpeech = async (path: string, init: RequestInit): Promise<Response> => {
  try {
    return await request(`${SPEECH_BASE_URL}${path}`, init)
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
      throw new SpeechUnsupportedError(error.status)
    }
    throw error
  }
}

/**
 * 廉价探测 ASR 是否已实现：不带音频、不解析响应体，只看状态码。
 * 404 / 501 → 未实现（false）；400 缺文件、401 未登录、429 限流等说明路由在 → 已实现（true）。
 * 请求没到达服务端（断网、超时）时返回 null，表示「这次没探出来」，调用方维持原有服务端流程。
 */
export const probeTranscribe = async (): Promise<boolean | null> => {
  try {
    // 探测不能把首次点击卡住：超时就当没探出来，交给原有流程
    await requestSpeech('/asr', { method: 'POST', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return true
  } catch (error) {
    if (isSpeechUnsupported(error)) {
      return false
    }
    return error instanceof ApiError && error.status !== undefined ? true : null
  }
}

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (audio: Blob, signal?: AbortSignal): Promise<string> => {
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const response = await requestSpeech('/asr', {
    method: 'POST',
    body: form,
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await requestSpeech('/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  return response.body
}
