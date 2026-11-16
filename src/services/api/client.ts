import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/**
 * 接口地址前缀，默认为空串即同源（BFF）；构建期可用 rspack 的 apiOrigin 覆盖，
 * 开发时由 devServer 把 /api 代理到 BFF。
 */
export const API_ORIGIN = __API_ORIGIN__
/** BFF 的 API 前缀：/api/chat、/api/files 都在这里 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/api`

/** 拼接 BFF 的相对路径；构建期配置了 apiOrigin 时同样成立 */
export const apiUrl = (path: string) => `${ANTHROPIC_BASE_URL}${path}`

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/** 所有请求都带上会话 Cookie；同源与跨域（配置了 apiOrigin 时）都需要显式声明。 */
export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'include', ...init })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/** 当前登录用户；字段与 BFF 的 SessionUser 一致 */
export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  /** 每日请求配额，服务端未返回时缺省 */
  dailyQuota?: number
}

type MeResponse = { ray?: string; user?: AuthUser | null }

/** GET /api/me：未登录返回 null（不报错），用于启动时判断是否需要登录 */
export const fetchMe = async (signal?: AbortSignal): Promise<AuthUser | null> => {
  const response = await request(apiUrl('/me'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  const body = (await response.json()) as MeResponse
  return body.user ?? null
}

/** POST /api/auth/login：成功后服务端下发 HttpOnly Cookie，这里返回当前用户 */
export const login = async (
  username: string,
  password: string,
  signal?: AbortSignal
): Promise<AuthUser> => {
  const response = await request(apiUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
    signal,
  })
  const body = (await response.json()) as MeResponse
  if (!body.user) {
    throw new ApiError('protocol', '')
  }
  return body.user
}

/** POST /api/auth/logout：服务端清除会话 Cookie */
export const logout = async (): Promise<void> => {
  await request(apiUrl('/auth/logout'), {
    method: 'POST',
    headers: { Accept: 'application/json' },
  })
}

/**
 * POST /api/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(apiUrl('/files'), {
    method: 'POST',
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /api/files/{file_id} */
export const deleteFile = async (fileId: string): Promise<void> => {
  await request(apiUrl(`/files/${encodeURIComponent(fileId)}`), {
    method: 'DELETE',
  })
}

/** GET /api/files/{file_id}：取回原件（缩略图与补传用） */
export const downloadFile = async (fileId: string, signal?: AbortSignal): Promise<Blob> => {
  const response = await request(apiUrl(`/files/${encodeURIComponent(fileId)}`), {
    method: 'GET',
    signal,
  })
  return response.blob()
}

/**
 * POST /api/chat（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(apiUrl('/chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
