/**
 * OpenAI 兼容上游的流式调用。
 *
 * 职责边界：这里只做传输 —— 发请求、解析 SSE、识别错误、结束流；形状翻译在 protocol/translate.ts，
 * Key 的选择与回写在 pool/index.ts。本文件不知道 DeepSeek 协议，也不写数据库。
 */

import { fetch, type Response } from 'undici'
import type { PoolPick } from '../pool/index.ts'
import type { OpenAiChunk, OpenAiMessage } from '../protocol/translate.ts'

/** 首 token 时限：超时即认为这把 Key 不可用，换一把重试（GOAL.md §7.2） */
export const FIRST_TOKEN_TIMEOUT_MS = 8_000

/** 错误信息里最多带多少上游正文，避免把整段报错塞进日志与前端 */
const MAX_DETAIL = 200

const truncate = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 上游返回非 2xx，或流里直接给了一帧 {"error": {...}}。
 * status 供 pool 回写（冷却 / 禁用），retryable 表示是否值得换一把 Key 再试。
 */
export class UpstreamError extends Error {
  /** 上游 HTTP 状态；流内错误用 502 占位 */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
  }

  /** 鉴权失败说明这把 Key 坏了；限流与 5xx 是暂时性的，都值得换 Key */
  get retryable(): boolean {
    return (
      this.status === 401 || this.status === 403 || this.status === 429 || this.status >= 500
    )
  }
}

export type StreamChatInput = {
  pick: PoolPick
  messages: OpenAiMessage[]
  /** 客户端断开或首 token 超时都会 abort 它 */
  signal: AbortSignal
}

/**
 * POST {baseUrl}/chat/completions（stream: true，带 include_usage），逐个产出分片。
 *
 * - 非 2xx 抛 UpstreamError（带 status）；
 * - 上游在流里发 error 分片同样抛 UpstreamError；
 * - 收到 [DONE] 或连接正常关闭即结束；
 * - signal 中止时抛 AbortError（调用方据 flag 区分是超时还是客户端断开）。
 */
export async function* streamChatCompletion(
  input: StreamChatInput
): AsyncGenerator<OpenAiChunk, void> {
  const { pick, messages, signal } = input
  const response = await postChatCompletion(pick, messages, signal)

  if (!response.ok) {
    // 读完正文再丢弃，避免连接悬挂；正文只取前若干字符
    const detail = await response.text().catch(() => '')
    const suffix = detail.trim() === '' ? '' : `：${truncate(detail.trim())}`
    throw new UpstreamError(response.status, `上游返回 ${response.status}${suffix}`)
  }
  if (!response.body) {
    throw new UpstreamError(502, '上游没有返回响应体')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawChunk = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const { lines, rest } = splitLines(buffer)
      buffer = rest
      for (const line of lines) {
        const parsed = parseDataLine(line)
        if (parsed === null) {
          continue
        }
        if (parsed === DONE) {
          return
        }
        sawChunk = true
        yield parsed
      }
    }

    // 上游没以换行收尾就断开时，最后一段还留在缓冲里
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      const parsed = parseDataLine(buffer)
      if (parsed === DONE) {
        return
      }
      if (parsed !== null) {
        sawChunk = true
        yield parsed
      }
    }

    // 200 但一帧 SSE 都没有：多半是中转站把流关了或直接回了 JSON
    if (!sawChunk) {
      const tail = buffer.trim() === '' ? '' : `：${truncate(buffer.trim())}`
      throw new UpstreamError(502, `上游没有按 SSE 返回${tail}`)
    }
  } finally {
    // 提前返回（[DONE] / 抛错 / 客户端断开）时释放连接
    try {
      await reader.cancel()
    } catch {
      // 连接已经断了，忽略
    }
  }
}

/** 发请求并拿到响应头；网络层失败统一包成 502（只有 401/403/429/5xx 才算「上游明确拒绝」）。 */
const postChatCompletion = async (
  pick: PoolPick,
  messages: OpenAiMessage[],
  signal: AbortSignal
): Promise<Response> => {
  try {
    return await fetch(`${pick.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pick.secret}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: pick.upstreamModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    })
  } catch (error) {
    // 中止是调用方主动的（超时 / 客户端断开），原样抛出让调用方判断
    if (signal.aborted) {
      throw error
    }
    throw new UpstreamError(502, `连接上游失败：${errorText(error)}`)
  }
}

const DONE = 'done'

/**
 * 一行 SSE → 分片。`[DONE]` 返回 'done'；
 * 注释行、event: 行、空行、坏 JSON 一律返回 null（不阻断整条流）。
 */
const parseDataLine = (line: string): OpenAiChunk | 'done' | null => {
  const text = line.trim()
  if (!text.startsWith('data:')) {
    return null
  }
  const payload = text.slice('data:'.length).trim()
  if (payload === '') {
    return null
  }
  if (payload === '[DONE]') {
    return DONE
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  if (isRecord(parsed.error)) {
    const message = readString(parsed.error.message) || payload
    throw new UpstreamError(502, `上游流内报错：${truncate(message)}`)
  }
  return parsed as OpenAiChunk
}

const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 按 CRLF / LF / CR 切行；结尾的 CR 可能是下一片 CRLF 的前半，留在 rest 里等下一片。
 * 与 deepseek-site 的 sse.ts 同思路，这里只需要行文本。
 */
const splitLines = (buffer: string): { lines: string[]; rest: string } => {
  const lines: string[] = []
  let start = 0
  let index = 0
  while (index < buffer.length) {
    const char = buffer[index]
    if (char === '\n') {
      lines.push(buffer.slice(start, index))
      index += 1
      start = index
      continue
    }
    if (char === '\r') {
      if (index + 1 >= buffer.length) {
        break
      }
      lines.push(buffer.slice(start, index))
      index += buffer[index + 1] === '\n' ? 2 : 1
      start = index
      continue
    }
    index += 1
  }
  return { lines, rest: buffer.slice(start) }
}
