import { apiUrl, request } from './api/client.js'

/**
 * BFF 能力矩阵：前端据此决定「语音/OCR 走服务端官方能力」还是「退回浏览器本地能力」。
 *
 * 服务端会按账号层级返回不同结果：
 * - 免费账号：official 全为 false，只能用浏览器兜底
 * - 授权账号 / 管理员：official 为 true，可用 DeepSeek 官方 TTS / ASR / OCR / 搜索
 */
export type CapabilityMatrix = {
  tier: 'admin' | 'user'
  official: {
    search: boolean
    fetch: boolean
    tts: boolean
    asr: boolean
    ocr: boolean
    document: boolean
  }
  browser: {
    speechRecognition: boolean
    speechSynthesis: boolean
  }
}

const FALLBACK: CapabilityMatrix = {
  tier: 'user',
  official: { search: false, fetch: false, tts: false, asr: false, ocr: false, document: false },
  browser: { speechRecognition: true, speechSynthesis: true },
}

let cached: CapabilityMatrix | null = null
let inflight: Promise<CapabilityMatrix> | null = null

/** 读一次能力矩阵（带缓存，登录态变化时由调用方 resetCapabilities()） */
export const fetchCapabilities = async (): Promise<CapabilityMatrix> => {
  if (cached) {
    return cached
  }
  inflight ??= request(apiUrl('/capabilities'), {})
    .then((response) => response.json() as Promise<CapabilityMatrix>)
    .then((matrix) => {
      cached = matrix
      return matrix
    })
    .catch(() => FALLBACK)
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 同步读缓存；还没加载过时返回 null，调用方按「未知」处理 */
export const currentCapabilities = (): CapabilityMatrix | null => cached

export const resetCapabilities = (): void => {
  cached = null
}

/** 某个官方能力是否可用（未加载时按不可用处理，避免误用） */
export const hasOfficial = (name: keyof CapabilityMatrix['official']): boolean =>
  cached?.official[name] === true
