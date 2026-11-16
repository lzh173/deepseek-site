/**
 * POST /api/chat：把 OpenAI 兼容上游的流式响应，翻译成 chat-demo 认识的 DeepSeek 事件流。
 * 契约见 GOAL.md §6.3 与 deepseek-site/src/services/api/{types,parseEvent,sse,client}.ts。
 *
 * 关键约束：
 * - 响应是 text/event-stream，事件名等于 JSON 的 type，以 message_stop 结束，不发 [DONE]；
 * - 收到上游第一个分片之前允许无感换 Key，全部失败则抛 503（全局处理器会补 ray）；
 * - 已经开始输出之后再失败，只能写一帧 error 后关闭，message 里同样带 ray。
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { badRequest, serverBusy, unauthorized } from '../lib/errors.ts'
import { nowIso } from '../lib/time.ts'
import type { SessionUser } from '../lib/user.ts'
import { requireUser } from '../plugins/auth.ts'
import { pickKey, reportKey, type PoolPick } from '../pool/index.ts'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  MessageStreamEvent,
  MessageUsage,
} from '../protocol/types.ts'
import { deriveTitle } from '../protocol/title.ts'
import {
  newMessageId,
  StreamTranslator,
  toOpenAiMessages,
  type OpenAiMessage,
} from '../protocol/translate.ts'
import {
  FIRST_TOKEN_TIMEOUT_MS,
  streamChatCompletion,
  UpstreamError,
} from '../providers/openai.ts'

/** 首次请求之外最多再换 3 次 Key（GOAL.md §7.2） */
const MAX_RETRIES = 3

// ---------- 请求体校验 ----------

/** 只声明本应用消费的两种块，其余块用宽松对象承接后丢弃 */
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() })
const fileBlockSchema = z.object({
  type: z.enum(['image', 'document']),
  source: z.object({ type: z.literal('file'), file_id: z.string() }),
})
const otherBlockSchema = z.object({ type: z.string() }).passthrough()

const messageSchema = z.union([
  z.object({ role: z.literal('latest_reminder'), content: z.string() }).passthrough(),
  z
    .object({
      role: z.literal('user'),
      content: z.union([
        z.string(),
        z.array(z.union([textBlockSchema, fileBlockSchema, otherBlockSchema])),
      ]),
    })
    .passthrough(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.array(z.union([textBlockSchema, otherBlockSchema])),
    })
    .passthrough(),
])

/** 宽松校验：允许前端带额外字段（passthrough），只保证翻译用到的字段存在 */
const bodySchema = z
  .object({
    model: z.string().min(1),
    system: z.string().optional(),
    messages: z.array(messageSchema).min(1),
    thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).passthrough().optional(),
    tools: z.array(z.object({ type: z.string() }).passthrough()).optional(),
    safety_check: z.object({ level: z.string() }).passthrough().optional(),
    title: z.object({ enabled: z.boolean() }).passthrough().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough()

/** 校验失败按 400 报；前端只会看到 error.message */
const parseBody = (raw: unknown): CreateMessageRequest => {
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') ?? ''
    const reason = issue?.message ?? '格式不正确'
    throw badRequest(`请求体不合法${where === '' ? '' : `（${where}）`}：${reason}`)
  }
  return parsed.data
}

// ---------- SSE 输出 ----------

/** 开始 SSE：hijack 之后自己写头，Fastify 不再插手响应 */
const openSse = (reply: FastifyReply, ray: string): void => {
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    // hijack 后全局插件设置的 x-ray-id 不会自动落地，这里补上（GOAL.md §12.1）
    'x-ray-id': ray,
  })
}

const canWrite = (reply: FastifyReply): boolean =>
  !reply.raw.destroyed && !reply.raw.writableEnded

/** 一帧 SSE：event 名等于 JSON 的 type，双换行结尾 */
const writeEvent = (reply: FastifyReply, event: MessageStreamEvent): void => {
  if (!canWrite(reply)) {
    return
  }
  reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

const writeEvents = (reply: FastifyReply, events: MessageStreamEvent[]): void => {
  for (const event of events) {
    writeEvent(reply, event)
  }
}

/** 已开始输出后出错：无名 error 帧，message 末尾带 ray，前端显示为「输出中断」（GOAL.md §12.3） */
const writeStreamError = (reply: FastifyReply, message: string, ray: string): void => {
  if (!canWrite(reply)) {
    return
  }
  const body: ApiErrorBody = { error: { message: `${message}（请求编号：${ray}）` } }
  reply.raw.write(`data: ${JSON.stringify(body)}\n\n`)
}

const endSse = (reply: FastifyReply): void => {
  if (!reply.raw.writableEnded) {
    reply.raw.end()
  }
}

// ---------- 上游尝试 ----------

type AttemptFailure = {
  /** 给前端看的文案：与 GOAL.md §12.2 一致，前端只读 error.message */
  message: string
  /** 只进日志与 usage_log 的技术细节，不发给前端 */
  detail: string
  status?: number | undefined
  retryable: boolean
}

type AttemptResult =
  /** 流已收尾：正常结束，或已经写过错误帧 */
  | {
      kind: 'settled'
      ok: boolean
      error?: string
      status?: number
      usage: MessageUsage
      ms: number
    }
  /** 首帧之前失败，可以换一把 Key 重试 */
  | { kind: 'retry'; failure: AttemptFailure }
  /** 客户端已断开，不用再做什么 */
  | { kind: 'client_gone' }

type AttemptContext = {
  app: FastifyInstance
  reply: FastifyReply
  pick: PoolPick
  messages: OpenAiMessage[]
  /** 对外展示的公开模型名 */
  model: string
  title: string | undefined
  ray: string
  /** 客户端断开信号 */
  client: AbortSignal
}

/** 所有上游失败的对外文案都统一成这一句，细节只进日志（GOAL.md §12.2） */
const UPSTREAM_BUSY = '服务器繁忙，请稍后再试'

/** 把网络类错误、超时与上游错误统一成可重试的失败描述 */
const toFailure = (error: unknown, timedOut: boolean): AttemptFailure => {
  const detail =
    timedOut && !(error instanceof UpstreamError)
      ? `上游首 token 超时（${FIRST_TOKEN_TIMEOUT_MS} ms）`
      : error instanceof Error
        ? error.message
        : String(error)
  return {
    message: UPSTREAM_BUSY,
    detail,
    status: error instanceof UpstreamError ? error.status : undefined,
    // DNS 失败、连接重置、协议错乱等：换一把 Key / 换一个渠道可能就好了
    retryable: error instanceof UpstreamError ? error.retryable : true,
  }
}

/**
 * 合并多个中止信号（客户端断开 + 本次尝试超时），dispose 时摘掉监听，
 * 避免一条长连接上堆积监听器。
 */
const linkSignals = (signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController()
  const bound: { signal: AbortSignal; handler: () => void }[] = []
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason)
    }
  }
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal.reason)
      break
    }
    const handler = (): void => abort(signal.reason)
    signal.addEventListener('abort', handler, { once: true })
    bound.push({ signal, handler })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, handler } of bound) {
        signal.removeEventListener('abort', handler)
      }
      bound.length = 0
    },
  }
}

/**
 * 跑一次上游流。
 * 首帧到达前失败 → 返回 retry，由调用方换 Key；首帧之后所有错误都落在已提交的响应上，只能写错误帧收尾。
 */
const runAttempt = async (ctx: AttemptContext): Promise<AttemptResult> => {
  const startedAt = Date.now()
  const attempt = new AbortController()
  const link = linkSignals([ctx.client, attempt.signal])
  const translator = new StreamTranslator({
    id: newMessageId(),
    model: ctx.model,
    ray: ctx.ray,
    ...(ctx.title === undefined ? {} : { title: ctx.title }),
  })

  let committed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, FIRST_TOKEN_TIMEOUT_MS)

  const stopTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  try {
    for await (const chunk of streamChatCompletion({
      pick: ctx.pick,
      messages: ctx.messages,
      signal: link.signal,
    })) {
      if (!committed) {
        // 首个分片到达 = 上游可用：此后不再换 Key
        committed = true
        stopTimer()
        openSse(ctx.reply, ctx.ray)
        writeEvents(ctx.reply, translator.start())
      }
      writeEvents(ctx.reply, translator.push(chunk))
    }
    stopTimer()

    if (!committed) {
      // 200 但一帧都没给：按上游故障处理，换 Key 重试
      throw new UpstreamError(502, '上游没有返回任何流式内容')
    }

    writeEvents(ctx.reply, translator.finish())
    endSse(ctx.reply)
    const ms = Date.now() - startedAt
    reportKey(ctx.app, ctx.pick, {
      ok: true,
      ms,
      inTok: translator.usage.input_tokens,
      outTok: translator.usage.output_tokens,
    })
    return { kind: 'settled', ok: true, usage: { ...translator.usage }, ms }
  } catch (error) {
    stopTimer()
    if (ctx.client.aborted) {
      // 客户端主动断开：不惩罚这把 Key，也没有人接收错误帧。
      // 还没 hijack 时不要直接碰 reply.raw，让 Fastify 自己收尾。
      if (committed) {
        endSse(ctx.reply)
      }
      return { kind: 'client_gone' }
    }

    const failure = toFailure(error, timedOut)
    // 只有「值得换 Key 再试」的失败才回写池子（GOAL.md §7.2：超时 / 5xx / 429 / 鉴权失败）；
    // 上游 400 之类多是我们自己的请求形状有问题，罚 Key 冷却没有意义。
    if (failure.retryable) {
      reportKey(ctx.app, ctx.pick, { ok: false, status: failure.status, error: failure.detail })
    }
    if (!committed) {
      return { kind: 'retry', failure }
    }

    // 已经输出过内容：写一帧错误再关闭（GOAL.md §12.3）
    writeStreamError(ctx.reply, failure.message, ctx.ray)
    endSse(ctx.reply)
    return {
      kind: 'settled',
      ok: false,
      error: failure.detail,
      status: failure.status,
      usage: { ...translator.usage },
      ms: Date.now() - startedAt,
    }
  } finally {
    stopTimer()
    link.dispose()
  }
}

// ---------- usage_log（后台按 ray 检索） ----------

const recordUsage = (
  app: FastifyInstance,
  input: {
    ray: string
    user: SessionUser
    pick: PoolPick | null
    result: AttemptResult | null
    /** 失败时的技术细节；成功为 null */
    err: string | null
    ms: number
  }
): void => {
  const { pick, result } = input
  const usage = result !== null && result.kind === 'settled' ? result.usage : null
  let status = 'error'
  if (result === null) {
    status = 'error'
  } else if (result.kind === 'client_gone') {
    status = 'aborted'
  } else if (result.kind === 'retry') {
    // 循环走完仍是 retry，说明所有 Key 都失败，最终返回 503
    status = 'busy'
  } else {
    status = result.ok ? 'ok' : 'error'
  }
  const error = status === 'ok' ? null : input.err
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
        pick?.channelId ?? null,
        pick?.keyId ?? null,
        pick?.publicModel ?? null,
        pick?.upstreamModel ?? null,
        usage?.input_tokens ?? null,
        usage?.output_tokens ?? null,
        input.ms,
        status,
        error
      )
  } catch (dbError) {
    // 日志失败不能影响已完成的响应
    app.log.warn({ err: dbError, ray: input.ray }, 'usage_log 写入失败')
  }
}

// ---------- 路由 ----------

export const chatRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/chat', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user
    if (!user) {
      throw unauthorized()
    }
    const body = parseBody(request.body)
    const ray = request.ray

    const messages = toOpenAiMessages({ system: body.system, messages: body.messages })
    if (!messages.some((message) => message.role !== 'system')) {
      throw badRequest('请求体不合法：没有可发送的消息')
    }
    // 标题纯本地生成，不产生任何上游调用（GOAL.md §9 #3）
    const title = body.title?.enabled === true ? deriveTitle(body.messages) : undefined

    // 客户端断开 → 中止上游。
    // 注意：request 的 close 在请求体读完时也会触发（Node 16+），不能直接当成断开；
    // 只有「响应还没写完 + 连接确实断了」才算客户端走了。响应侧的 close 是同一判定的兜底。
    const client = new AbortController()
    const onClientGone = (): void => {
      if (reply.raw.writableEnded) {
        return
      }
      const socket = request.raw.socket
      if (socket !== null && socket !== undefined && !socket.destroyed) {
        return
      }
      client.abort()
    }
    request.raw.on('close', onClientGone)
    reply.raw.on('close', onClientGone)

    const startedAt = Date.now()
    let pick: PoolPick | null = null
    let result: AttemptResult | null = null
    let lastDetail: string | null = null

    try {
      for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
        // 每次重试都重新选 Key：上一把失败后已进入冷却，不会被再次选中；
        // 授权边界由 pickKey 保证，故障转移不会越界。
        pick = await pickKey(app, { publicModel: body.model, user })
        result = await runAttempt({
          app,
          reply,
          pick,
          messages,
          model: body.model,
          title,
          ray,
          client: client.signal,
        })
        if (result.kind !== 'retry') {
          if (result.kind === 'settled' && !result.ok) {
            lastDetail = result.error ?? null
          }
          return
        }
        lastDetail = result.failure.detail
        request.log.warn(
          { ray, retry, status: result.failure.status, err: result.failure.detail },
          '上游尝试失败，换 Key 重试'
        )
        if (!result.failure.retryable) {
          // 不可重试（如上游 400 / 协议不兼容），换 Key 也没用
          break
        }
      }
      // 首帧之前全部失败：交给全局错误处理器返回 503 JSON + ray（前端显示「服务器繁忙」）
      throw serverBusy()
    } finally {
      request.raw.off('close', onClientGone)
      reply.raw.off('close', onClientGone)
      recordUsage(app, { ray, user, pick, result, err: lastDetail, ms: Date.now() - startedAt })
    }
  })
}
