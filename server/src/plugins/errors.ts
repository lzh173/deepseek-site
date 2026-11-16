import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { HttpError, type ErrorType } from '../lib/errors.ts'
import { newRay } from '../lib/ray.ts'

const ALREADY_HAS_RAY = /（请求编号：ray_[0-9a-f]{12}）$/

/** GOAL.md §12.1：错误 message 末尾统一追加 ray，不区分状态码。 */
const withRay = (message: string, ray: string): string => {
  const trimmed = message.trim()
  return ALREADY_HAS_RAY.test(trimmed) ? trimmed : `${trimmed}（请求编号：${ray}）`
}

const typeForStatus = (status: number): ErrorType => {
  if (status === 400) return 'invalid_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 413) return 'payload_too_large'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'internal'
  return 'invalid_request'
}

/** 把框架自带的英文错误文案换成面向用户的中文；其余保持原样。 */
const localizeMessage = (status: number, message: string): string => {
  if (status === 429 && /rate limit exceeded/i.test(message)) {
    return '请求过于频繁，请稍后再试'
  }
  if (status === 413 && /request body is too large/i.test(message)) {
    return '请求体过大'
  }
  return message
}

export const errorPlugin = fp((app: FastifyInstance, _opts: unknown, done: () => void) => {
  app.setErrorHandler((error, request, reply) => {
    const ray = request.ray || newRay()

    if (reply.raw.headersSent) {
      request.log.error({ err: error, ray }, 'stream already started, closing')
      reply.raw.end()
      return
    }

    if (error instanceof HttpError) {
      void reply.code(error.status).type('application/json; charset=utf-8').send({
        ray,
        error: { type: error.type, message: withRay(error.message, ray) },
      })
      return
    }

    const statusCode = (error as { statusCode?: unknown }).statusCode
    const status =
      typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599 ? statusCode : 500
    const rawMessage = typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : '服务器内部错误'

    request.log.error({ err: error, ray, status }, 'request failed')

    void reply.code(status).type('application/json; charset=utf-8').send({
      ray,
      error: {
        type: typeForStatus(status),
        message: withRay(
          status >= 500 ? '服务器内部错误' : localizeMessage(status, rawMessage),
          ray
        ),
      },
    })
  })

  app.setNotFoundHandler((request, reply) => {
    const ray = request.ray || newRay()
    void reply.code(404).type('application/json; charset=utf-8').send({
      ray,
      error: { type: 'not_found', message: withRay('接口不存在', ray) },
    })
  })

  done()
})
