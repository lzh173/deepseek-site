import type { FastifyInstance } from 'fastify'
import type { FastifyBaseLogger } from 'fastify'
import type { SessionUser } from '../lib/user.ts'
import { canUseOfficialTools, officialUrl, requireOfficialTools } from './official.ts'

/**
 * 官方 OCR（/v1/tools/ocr）：把 PDF / Word / PPT / 图片逐页识别成文字。
 *
 * 相比本地解析，它多了两个关键能力：
 * - 扫描件、纯图 PDF 也能识别（本地只能抽文本层）
 * - 图片里的文字（截图、扫描件）同样能拿到
 *
 * 结果里的 `<｜ref｜>` / `<｜box｜>` 标记与坐标对聊天没用，统一剥掉，只留文字。
 */

const OCR_TIMEOUT_MS = 180_000
const OCR_MAX_BYTES = 100 * 1024 * 1024

/** 去掉 OCR 输出的版面标记，只保留可读文字 */
const stripOcrMarks = (text: string): string =>
  text
    .replace(/<｜ref｜>([\s\S]*?)<｜\/ref｜>/gu, '$1')
    .replace(/<｜box｜>[\s\S]*?<｜\/box｜>/gu, '')
    .replace(/<｜[\s\S]*?｜>/gu, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()

export type OcrResult = { text: string; pages: number }

/**
 * 用官方 OCR 识别一个文件。
 * 失败返回 null（调用方退回本地解析），不让附件解析把对话拖垮。
 */
export const officialOcr = async (
  app: FastifyInstance,
  user: SessionUser,
  bytes: Buffer,
  filename: string,
  mime: string,
  signal: AbortSignal,
  log?: FastifyBaseLogger
): Promise<OcrResult | null> => {
  if (!canUseOfficialTools(app, user, 'ocr') || bytes.byteLength === 0) {
    return null
  }
  if (bytes.byteLength > OCR_MAX_BYTES) {
    log?.warn({ filename, size: bytes.byteLength }, '文件超过官方 OCR 的 100MB 上限')
    return null
  }

  let credential
  try {
    credential = requireOfficialTools(app, user, 'ocr')
  } catch {
    return null
  }

  try {
    const form = new FormData()
    // 顺序很重要：purpose 必须在 file 之前（官方文档明确要求）
    form.append('purpose', 'text_recognition')
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime || 'application/octet-stream' }), filename)

    const response = await fetch(officialUrl(credential, '/v1/tools/ocr'), {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.secret}` },
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(OCR_TIMEOUT_MS)]),
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      log?.warn({ filename, status: response.status }, '官方 OCR 请求失败')
      return null
    }

    // 识别期间服务端会持续发送换行保活，整个响应体按 JSON 解析即可
    const raw = await response.text()
    const payload = JSON.parse(raw) as {
      error?: { message?: string }
      pages?: { index: number; text?: string }[]
      page_count?: number
    }

    if (payload.error) {
      log?.warn({ filename, error: payload.error.message }, '官方 OCR 返回错误')
      return null
    }

    const pages = Array.isArray(payload.pages) ? payload.pages : []
    const text = pages
      .map((page) => stripOcrMarks(page.text ?? ''))
      .filter((item) => item.length > 0)
      .join('\n\n')

    if (text === '') {
      return null
    }
    return { text, pages: payload.page_count ?? pages.length }
  } catch (error) {
    log?.warn({ filename, err: error }, '官方 OCR 异常')
    return null
  }
}
