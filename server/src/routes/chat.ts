/**
 * POST /api/chat：把 OpenAI 兼容上游的流式响应，翻译成 chat-demo 认识的 DeepSeek 事件流。
 * 契约见 GOAL.md §6.3 与 deepseek-site/src/services/api/{types,parseEvent,sse,client}.ts。
 *
 * 关键约束：
 * - 响应是 text/event-stream，事件名等于 JSON 的 type，以 message_stop 结束，不发 [DONE]；
 * - 收到上游第一个分片之前允许无感换 Key，全部失败则抛 503（全局处理器会补 ray）；
 * - 已经开始输出之后再失败，只能写一帧 error 后关闭，message 里同样带 ray。
 */

import fs from 'node:fs'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { extractDocument } from '../caps/documents.ts'
import { readUrl, type ReadResult } from '../caps/reader.ts'
import { searchWeb, type SearchHit } from '../caps/search.ts'
import type { FileRow } from '../db/types.ts'
import { moderateText } from '../caps/moderation.ts'
import { badRequest, quotaExceeded, serverBusy, unauthorized } from '../lib/errors.ts'
import { nowIso, todayUtc } from '../lib/time.ts'
import type { SessionUser } from '../lib/user.ts'
import { requireUser } from '../plugins/auth.ts'
import { pickKey, reportKey, type PoolPick } from '../pool/index.ts'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  ToolParam,
} from '../protocol/types.ts'
import {
  readToolResult,
  readToolUse,
  searchToolResult,
  searchToolResultError,
  searchToolUse,
  toToolBlockEvents,
  type ToolBlock,
} from '../protocol/tools.ts'
import { deriveTitle } from '../protocol/title.ts'
import {
  newMessageId,
  StreamTranslator,
  toOpenAiMessages,
  type OpenAiMessage,
  type ResolvedFile,
} from '../protocol/translate.ts'
import {
  firstTokenTimeoutMs,
  streamChatCompletion,
  UpstreamError,
} from '../providers/openai.ts'
import { canAccessFile, fileDiskPath, findFile, isSha256 } from '../storage/files.ts'

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

// ---------- 用户日配额 ----------

/**
 * 用户日配额（GOAL.md §11.1）：当天（UTC）status='ok' 的 usage_log 行数达到上限就拒绝。
 * dailyQuota = 0 表示不限（管理员默认）；必须在流开始之前抛，前端拿到的才是 429 JSON + ray。
 */
const assertDailyQuota = (app: FastifyInstance, user: SessionUser): void => {
  if (user.dailyQuota <= 0) {
    return
  }
  const dayStart = `${todayUtc()}T00:00:00.000Z`
  const row = app.db
    .prepare(
      `SELECT COUNT(*) AS n FROM usage_log
       WHERE user_id = ? AND ts >= ? AND status = 'ok'`
    )
    .get(user.id, dayStart) as { n: number } | undefined
  const used = row?.n ?? 0
  if (used >= user.dailyQuota) {
    throw quotaExceeded()
  }
}

// ---------- 附件预处理（GOAL.md §9 #6 / #7、§10） ----------

/** 图片内联上限：超过就不整块读进内存（前端会把图片压到 ≤1 MB，这里按 10 MB 兜底） */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

/** 本轮全部文档正文的合计上限：再多只会把对话历史挤出去 */
const MAX_DOCUMENT_CHARS_TOTAL = 40_000

/** 一个待解析的附件块 */
type AttachmentBlock = { fileId: string; kind: 'image' | 'document' }

/** 从消息块里认出附件块；结构不对的一律忽略（脏数据不该让整轮请求失败） */
const attachmentOf = (block: unknown): AttachmentBlock | null => {
  if (block === null || typeof block !== 'object') {
    return null
  }
  const record = block as Record<string, unknown>
  if (record.type !== 'image' && record.type !== 'document') {
    return null
  }
  const source = record.source
  if (source === null || typeof source !== 'object') {
    return null
  }
  const fileId = (source as Record<string, unknown>).file_id
  if (typeof fileId !== 'string' || fileId === '') {
    return null
  }
  return { fileId, kind: record.type }
}

/** 按消息顺序收集附件；同一个文件只解析一次（历史里可能反复引用同一份） */
const collectAttachments = (messages: MessageParam[]): AttachmentBlock[] => {
  const seen = new Set<string>()
  const blocks: AttachmentBlock[] = []
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') {
      continue
    }
    for (const block of message.content) {
      const attachment = attachmentOf(block)
      if (!attachment || seen.has(attachment.fileId)) {
        continue
      }
      seen.add(attachment.fileId)
      blocks.push(attachment)
    }
  }
  return blocks
}

/** 可以直接拼进 content 的文本：占位说明或文档正文 */
type TextEntry = { kind: 'text'; text: string }

/** 附件失效：文件被清理 / 从未登记 / 不属于当前用户。只占位，绝不中断对话（§9 铁律 3）。 */
const expiredFile = (fileId: string): TextEntry => ({
  kind: 'text',
  text: `[附件已失效: ${fileId}]`,
})

/** 看不了图片：明说没看见，不让模型假装看过（§9 铁律 1、§10） */
const unreadableImage = (fileId: string): TextEntry => ({
  kind: 'text',
  text: `[附件: ${fileId}（当前模型无法识别图片）]`,
})

/** 文档抽取失败：同样显式降级，不用空正文糊弄模型 */
const unreadableDocument = (fileId: string): TextEntry => ({
  kind: 'text',
  text: `[附件: ${fileId}（无法解析该文档）]`,
})

/** data URL 的 MIME 必须是裸类型（不带参数）；异常值退回 png，部分上游不认别的 */
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/i

const normalizeImageMime = (mime: string): string => (IMAGE_MIME_RE.test(mime) ? mime : 'image/png')

/**
 * 目标模型声明的 vision 能力。
 * 模型不存在或 caps_json 损坏都按「看不了图」处理：真正的 404/503 由随后的 pickKey 抛出。
 */
const modelSupportsVision = (app: FastifyInstance, publicModel: string): boolean => {
  const row = app.db
    .prepare('SELECT caps_json FROM models WHERE id = ? AND enabled = 1')
    .get(publicModel) as { caps_json: string } | undefined
  if (!row) {
    return false
  }
  try {
    const caps = JSON.parse(row.caps_json || '{}') as { vision?: unknown }
    return caps.vision === true
  } catch {
    return false
  }
}

/** 读原件字节；记录还在但磁盘丢了时返回 null，由调用方降级成「已失效」 */
const readFileBytes = async (fileId: string): Promise<Buffer | null> =>
  fs.promises.readFile(fileDiskPath(fileId)).catch(() => null)

/**
 * 图片 → data URL（base64 内联）。
 * 只有模型支持 vision 且体积在上限内才会走到这里，读不到字节返回 null。
 */
const inlineImage = async (
  fileId: string,
  mime: string
): Promise<{ kind: 'image'; url: string } | null> => {
  const bytes = await readFileBytes(fileId)
  if (bytes === null || bytes.byteLength === 0) {
    return null
  }
  return {
    kind: 'image',
    url: `data:${normalizeImageMime(mime)};base64,${bytes.toString('base64')}`,
  }
}

/** 预算截断标记（与 caps/documents.ts 的单文档标记一致，便于模型识别正文不完整） */
const DOCUMENT_TRUNCATED_MARK = '\n…（已截断）'

/**
 * 一个附件解析完成后的产物。文档单独保留「文件名 + 全文」，
 * 因为注入时的 40000 字符总预算要按**每次引用**扣，而不是按文件扣：
 * 同一份文档在历史里出现两次时，第二次也可能被截断甚至省略。
 */
type AttachmentEntry =
  /** 图片：[{type:'image_url', image_url:{url}}] */
  | { kind: 'image'; url: string }
  /** 文档：filename 是上传时的原始名，text 已按单文档 20000 字符上限截断 */
  | { kind: 'document'; filename: string; text: string }
  /** 占位文本（已失效 / 看不了图 / 无法解析） */
  | { kind: 'text'; text: string }

/** 读文档：抽不出正文时降级成占位文本（绝不抛，见 §9 铁律 3） */
const documentEntry = async (
  fileId: string,
  row: FileRow,
  bytes: Buffer
): Promise<AttachmentEntry> => {
  const extracted = await extractDocument(bytes, row.mime, row.name)
  if (!extracted) {
    return unreadableDocument(fileId)
  }
  return { kind: 'document', filename: row.name, text: extracted.text }
}

type AttachmentInput = {
  app: FastifyInstance
  user: SessionUser
  messages: MessageParam[]
  /** 目标模型能否看图（models.caps_json.vision） */
  vision: boolean
  ray: string
  signal: AbortSignal
  log: FastifyBaseLogger
}

/**
 * 把 image / document 块解析成可以直接发给上游的内容：
 * - 图片：`caps.vision` 为真且 ≤ 10 MB → data URL；否则占位文本（§10 的①②③链路在前端做）；
 * - 文档：抽成正文（§9 #6）；
 * - 文件不存在 / 无权限 / 读盘失败：`[附件已失效: id]`，不中断对话。
 *
 * 单个附件出任何问题都只影响它自己的占位，不向外抛。
 */
const resolveAttachments = async (
  input: AttachmentInput
): Promise<Map<string, AttachmentEntry>> => {
  const resolved = new Map<string, AttachmentEntry>()

  for (const attachment of collectAttachments(input.messages)) {
    if (input.signal.aborted) {
      break
    }
    const { fileId, kind } = attachment
    try {
      // 先验归属再读盘：不属于当前用户的 id 只会得到「已失效」，不泄露文件是否存在
      const row = isSha256(fileId) ? findFile(input.app.db, fileId) : null
      if (!row || !canAccessFile(input.app.db, input.user.id, fileId)) {
        resolved.set(fileId, expiredFile(fileId))
        continue
      }

      if (kind === 'image') {
        // 看不了图 / 图片过大 / 挂的不是图片：占位。不要把图片硬塞给不支持多模态的上游
        if (!input.vision || row.size > MAX_INLINE_IMAGE_BYTES || !row.mime.startsWith('image/')) {
          resolved.set(fileId, unreadableImage(fileId))
          continue
        }
        const image = await inlineImage(fileId, row.mime)
        resolved.set(fileId, image !== null ? image : expiredFile(fileId))
        continue
      }

      const bytes = await readFileBytes(fileId)
      if (bytes === null) {
        resolved.set(fileId, expiredFile(fileId))
        continue
      }
      resolved.set(fileId, await documentEntry(fileId, row, bytes))
    } catch (error) {
      input.log.warn({ ray: input.ray, fileId, kind, err: error }, '附件解析失败，改用占位文本')
      resolved.set(fileId, kind === 'image' ? unreadableImage(fileId) : unreadableDocument(fileId))
    }
  }

  return resolved
}

/**
 * 把解析结果包成翻译层要的回调。每调用一次就扣一次文档预算，
 * 因此「多个文档合计注入不超过 40000 字符」是按实际注入的正文统计的：
 * 预算耗尽后，后续文档（含重复引用同一份）直接省略，不会悄悄超出上限。
 */
const createFileResolver = (
  entries: Map<string, AttachmentEntry>
): ((fileId: string) => ResolvedFile | null) => {
  let budget = MAX_DOCUMENT_CHARS_TOTAL

  return (fileId: string): ResolvedFile | null => {
    const entry = entries.get(fileId)
    if (!entry) {
      return null
    }
    if (entry.kind === 'image') {
      return { kind: 'image', url: entry.url }
    }
    if (entry.kind === 'text') {
      return { kind: 'text', text: entry.text }
    }

    const header = `【文档：${entry.filename}】\n`
    const room = budget - header.length
    if (room <= DOCUMENT_TRUNCATED_MARK.length) {
      // 预算已耗尽（连截断标记都放不下）：明确不注入，避免退回 [附件: id] 这类误导性占位
      return { kind: 'skip' }
    }
    const body =
      entry.text.length > room
        ? `${entry.text.slice(0, room - DOCUMENT_TRUNCATED_MARK.length)}${DOCUMENT_TRUNCATED_MARK}`
        : entry.text
    const text = `${header}${body}`
    budget -= text.length
    return { kind: 'text', text }
  }
}

// ---------- 联网工具预处理（GOAL.md §9 #4 / #5） ----------

/** 查询文本上限：搜索词太长对召回没有帮助，只会浪费上游 token */
const MAX_QUERY_CHARS = 200
/** 注入 system 的每条摘要上限 */
const MAX_SNIPPET_CHARS = 200
/** 注入 system 的每篇正文上限 */
const MAX_READ_CHARS = 8_000
/** 单轮最多读几个链接 */
const MAX_READ_LINKS = 2
/** 检索结果注入 system 时的固定引导语 */
const SEARCH_NOTE_HEADER = '以下是检索结果，请据此回答并在句末用 [1][2] 标注来源：'
/** 读链接正文注入 system 时的固定引导语 */
const READ_NOTE_HEADER = '以下是用户消息中链接的正文，请结合这些内容回答：'

type PreparedTools = {
  /** 第一个文本块之前要按顺序下发的工具块 */
  blocks: ToolBlock[]
  /** 追加到 system 的检索/正文材料 */
  notes: string[]
}

/** 最后一条 user 消息的纯文本：搜索查询与读链接都以它为输入 */
const lastUserText = (messages: MessageParam[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') {
      continue
    }
    if (typeof message.content === 'string') {
      return message.content
    }
    return message.content
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  }
  return ''
}

/** body.tools 里是否声明了某个服务端工具（前端同时带 type 与 name） */
const declaredTool = (tools: ToolParam[] | undefined, name: string): boolean =>
  (tools ?? []).some((tool) => tool.type === name || tool.name === name)

/** 从最后一条用户消息里提取 http(s) 链接；句末标点不算链接的一部分 */
const extractLinks = (text: string): string[] => {
  const links: string[] = []
  for (const matched of text.matchAll(/https?:\/\/[^\s<>"'`\u3000]+/gi)) {
    const link = (matched[0] ?? '').replace(/[.,;:!?，。；：！？、）)】"'”’]+$/u, '')
    if (link === '' || links.includes(link)) {
      continue
    }
    links.push(link)
    if (links.length >= MAX_READ_LINKS) {
      break
    }
  }
  return links
}

const formatSearchNote = (hits: SearchHit[]): string => {
  const lines = hits.map((hit, index) => {
    const snippet = hit.snippet === '' ? '' : `\n   摘要：${hit.snippet.slice(0, MAX_SNIPPET_CHARS)}`
    return `[${index + 1}] ${hit.title}\n   URL：${hit.url}${snippet}`
  })
  return `${SEARCH_NOTE_HEADER}\n${lines.join('\n')}`
}

const formatReadNote = (results: ReadResult[]): string => {
  const blocks = results.map((result) => {
    const title = result.title ?? result.url
    return `【${title}】${result.url}\n${result.text.slice(0, MAX_READ_CHARS)}`
  })
  return `${READ_NOTE_HEADER}\n\n${blocks.join('\n\n')}`
}

/**
 * 联网搜索：先下发调用块（表示「尝试检索过」），再下发结果块；
 * 有结果时把结果列表注入 system，没有结果时结果块只含一个 error 项，对话照常继续（§9 铁律 3）。
 */
const prepareSearch = async (
  ray: string,
  rawQuery: string,
  signal: AbortSignal,
  log: FastifyBaseLogger
): Promise<{ blocks: ToolBlock[]; note: string | null }> => {
  const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS)
  if (query === '') {
    // 只发了附件之类：没有可检索的文本，不发工具块
    log.debug({ ray }, '联网搜索已开启，但最后一条用户消息没有文本')
    return { blocks: [], note: null }
  }

  const toolUse = searchToolUse(ray, [query])
  const hits = await searchWeb([query], signal)
  if (hits.length === 0) {
    // 失败路径同样先发调用块：tool_use_id 才不会悬空，前端也能把这次检索标成失败
    log.info({ ray, query }, '联网搜索没有可用结果，本轮退化为普通对话')
    return { blocks: [toolUse, searchToolResultError(toolUse.id)], note: null }
  }

  return {
    blocks: [toolUse, searchToolResult(toolUse.id, hits)],
    note: formatSearchNote(hits),
  }
}

/** 读链接：成功的链接各发一对「调用块 + 结果块」，正文注入 system；失败的只记日志 */
const prepareRead = async (
  ray: string,
  links: string[],
  signal: AbortSignal,
  log: FastifyBaseLogger
): Promise<{ blocks: ToolBlock[]; note: string | null }> => {
  if (links.length === 0) {
    return { blocks: [], note: null }
  }

  const fetched = await Promise.all(
    links.map(async (link) => {
      try {
        return { link, result: await readUrl(link, signal) }
      } catch (error) {
        // 单个链接失败不能拖垮对话：只记日志，跳过这一条
        log.warn({ ray, url: link, err: error }, '读取链接失败，跳过该链接')
        return null
      }
    })
  )

  const blocks: ToolBlock[] = []
  const results: ReadResult[] = []
  let seq = 0
  for (const item of fetched) {
    if (!item) {
      continue
    }
    seq += 1
    const toolUse = readToolUse(ray, item.link, seq)
    blocks.push(toolUse, readToolResult(toolUse.id, item.result))
    results.push(item.result)
  }
  if (results.length === 0) {
    return { blocks: [], note: null }
  }
  return { blocks, note: formatReadNote(results) }
}

/**
 * 在发起上游请求之前跑完全部联网工具。
 * 顺序固定：先搜索、后读链接；两类工具并行执行，减少首字延迟。
 * 任何失败都只降级成普通对话，绝不把异常抛给路由层。
 */
const prepareTools = async (input: {
  ray: string
  tools: ToolParam[] | undefined
  messages: MessageParam[]
  signal: AbortSignal
  log: FastifyBaseLogger
}): Promise<PreparedTools> => {
  const wantSearch = declaredTool(input.tools, 'deepseek_web_search')
  const wantRead = declaredTool(input.tools, 'deepseek_read_url')
  if (!wantSearch && !wantRead) {
    return { blocks: [], notes: [] }
  }

  const text = lastUserText(input.messages)
  try {
    const [search, read] = await Promise.all([
      wantSearch ? prepareSearch(input.ray, text, input.signal, input.log) : Promise.resolve(null),
      wantRead
        ? prepareRead(input.ray, extractLinks(text), input.signal, input.log)
        : Promise.resolve(null),
    ])

    const blocks: ToolBlock[] = []
    const notes: string[] = []
    if (search) {
      blocks.push(...search.blocks)
      if (search.note !== null) {
        notes.push(search.note)
      }
    }
    if (read) {
      blocks.push(...read.blocks)
      if (read.note !== null) {
        notes.push(read.note)
      }
    }
    return { blocks, notes }
  } catch (error) {
    input.log.warn({ ray: input.ray, err: error }, '联网工具预处理失败，按普通对话继续')
    return { blocks: [], notes: [] }
  }
}

/** 把工具材料接到 system 末尾；没有 system 就新建一条，保持「system 恒在最前」 */
const withSystemNotes = (messages: OpenAiMessage[], notes: string[]): OpenAiMessage[] => {
  if (notes.length === 0) {
    return messages
  }
  const extra = notes.join('\n\n')
  const first = messages[0]
  if (first && first.role === 'system') {
    // system 一定是翻译层拼出来的字符串；这里兜一下类型（图片分片只会出现在 user 消息里）
    const head = typeof first.content === 'string' ? first.content : ''
    return [{ role: 'system', content: `${head}\n\n${extra}` }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: extra }, ...messages]
}

/**
 * 工具块占据最前面的若干个块索引，translate 产出的块索引要整体后移，
 * 保证 start / delta / stop 用的是同一个、且连续的索引。
 */
const shiftBlockIndexes = (events: MessageStreamEvent[], offset: number): MessageStreamEvent[] => {
  if (offset === 0) {
    return events
  }
  return events.map((event) => {
    switch (event.type) {
      case 'content_block_start':
      case 'content_block_delta':
      case 'content_block_stop':
        return { ...event, index: event.index + offset }
      default:
        return event
    }
  })
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
  /** 第一个文本块之前要下发的工具块事件（索引已从 0 排好） */
  toolEvents: MessageStreamEvent[]
  /** 工具块数量：translate 产出的块索引从这里往后排 */
  blockOffset: number
  /** 只有客户端明确开了深度思考才下发 thinking 块 */
  emitThinking: boolean
}

/** 所有上游失败的对外文案都统一成这一句，细节只进日志（GOAL.md §12.2） */
const UPSTREAM_BUSY = '服务器繁忙，请稍后再试'

/** 把网络类错误、超时与上游错误统一成可重试的失败描述 */
const toFailure = (error: unknown, timedOut: boolean): AttemptFailure => {
  const detail =
    timedOut && !(error instanceof UpstreamError)
      ? `上游首 token 超时（${firstTokenTimeoutMs()} ms）`
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
    emitThinking: ctx.emitThinking,
    ...(ctx.title === undefined ? {} : { title: ctx.title }),
  })

  let committed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, firstTokenTimeoutMs())

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
        // 工具块必须在第一个文本增量之前全部落地（索引 0 起，文本块排在它们之后）
        writeEvents(ctx.reply, ctx.toolEvents)
      }
      writeEvents(ctx.reply, shiftBlockIndexes(translator.push(chunk), ctx.blockOffset))
    }
    stopTimer()

    if (!committed) {
      // 200 但一帧都没给：按上游故障处理，换 Key 重试
      throw new UpstreamError(502, '上游没有返回任何流式内容')
    }

    writeEvents(ctx.reply, shiftBlockIndexes(translator.finish(), ctx.blockOffset))
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
    // 日配额在进流之前校验：超限直接 429 JSON + ray（GOAL.md §11.1）
    assertDailyQuota(app, user)

    // 本地关键词审核（GOAL.md §9 #10）；未配置词表时纯透传
    const verdict = moderateText(lastUserText(body.messages))
    if (verdict.blocked) {
      request.log.warn({ ray, keyword: verdict.hit }, '内容审核命中本地关键词')
      throw badRequest('内容不符合使用规范')
    }

    // 标题纯本地生成，不产生任何上游调用（GOAL.md §9 #3）
    const title = body.title?.enabled === true ? deriveTitle(body.messages) : undefined

    // 客户端断开 → 中止附件解析、工具预处理与上游。
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

    // 附件必须在构造上游 messages 之前落定：图片内联成 data URL、文档抽成正文
    // （GOAL.md §9 #6 / #7、§10）。解析失败只留占位文本，不会中断对话。
    const files = await resolveAttachments({
      app,
      user,
      messages: body.messages,
      vision: modelSupportsVision(app, body.model),
      ray,
      signal: client.signal,
      log: request.log,
    })
    const baseMessages = toOpenAiMessages({
      system: body.system,
      messages: body.messages,
      resolveFile: createFileResolver(files),
    })
    if (!baseMessages.some((message) => message.role !== 'system')) {
      throw badRequest('请求体不合法：没有可发送的消息')
    }

    // 联网工具必须在发起上游请求之前跑完：检索/正文要注入 system，
    // 工具块也要排在第一个文本块之前（GOAL.md §9 #4 / #5）
    const prepared = await prepareTools({
      ray,
      tools: body.tools,
      messages: body.messages,
      signal: client.signal,
      log: request.log,
    })
    const messages = withSystemNotes(baseMessages, prepared.notes)
    const toolEvents = toToolBlockEvents(prepared.blocks)
    const blockOffset = prepared.blocks.length

    let pick: PoolPick | null = null
    let result: AttemptResult | null = null
    let lastDetail: string | null = null

    try {
      for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
        // 每次重试都重新选 Key：上一把失败后已进入冷却，不会被再次选中；
        // 授权边界由 pickKey 保证，故障转移不会越界。
        try {
          pick = await pickKey(app, { publicModel: body.model, user })
        } catch (error) {
          // 选 Key 就失败（全冷却 / 未授权 / 模型停用）：只在还没有上游明细时记录，
          // 否则会把更重要的上游报错覆盖成「没有可用 Key」。
          lastDetail ??= error instanceof Error ? error.message : String(error)
          throw error
        }
        result = await runAttempt({
          app,
          reply,
          pick,
          messages,
          model: body.model,
          title,
          ray,
          client: client.signal,
          toolEvents,
          blockOffset,
          emitThinking: body.thinking?.type === 'enabled',
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
