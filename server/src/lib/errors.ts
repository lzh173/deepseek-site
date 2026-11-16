/**
 * 统一错误类型。状态码语义见 GOAL.md §12.3：
 *   401 未登录 / 403 无权限 / 429 配额 / 5xx 服务繁忙（前端据此显示「重试」）。
 * 全局错误处理器会把 ray 拼进 message，调用方不要自己拼。
 */
export type ErrorType =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'user_quota_exceeded'
  | 'server_busy'
  | 'upstream_unavailable'
  | 'conflict'
  | 'internal'

export class HttpError extends Error {
  readonly status: number
  readonly type: ErrorType

  constructor(status: number, type: ErrorType, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.type = type
  }
}

export const badRequest = (message: string): HttpError =>
  new HttpError(400, 'invalid_request', message)

export const unauthorized = (message = '请先登录'): HttpError =>
  new HttpError(401, 'unauthorized', message)

export const forbidden = (message = '无权访问'): HttpError => new HttpError(403, 'forbidden', message)

export const notFound = (message = '资源不存在'): HttpError =>
  new HttpError(404, 'not_found', message)

export const tooLarge = (message = '文件过大'): HttpError =>
  new HttpError(413, 'payload_too_large', message)

export const rateLimited = (message = '请求过于频繁'): HttpError =>
  new HttpError(429, 'rate_limited', message)

export const quotaExceeded = (message = '今日配额已用完'): HttpError =>
  new HttpError(429, 'user_quota_exceeded', message)

export const serverBusy = (message = '服务器繁忙，请稍后再试'): HttpError =>
  new HttpError(503, 'server_busy', message)

export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message)
