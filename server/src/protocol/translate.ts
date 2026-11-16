/**
 * 上游 OpenAI 形状 → DeepSeek 形状的翻译层。见 GOAL.md §6.3。
 *
 * 两件事：
 *   1. toOpenAiMessages：把前端发来的 MessageParam[] 压成上游认的 messages；
 *      latest_reminder 并入 system，assistant 只留 text；
 *      附件由调用方先解析成「文本正文 / 内联图片 data URL」再传进来，解析不到的才是文本占位。
 *   2. StreamTranslator：上游流式分片 → message_start / content_block_* / message_delta / message_stop
 *      的事件状态机，块索引从 0 递增且 start/delta/stop 共用同一个 index。
 *
 * 本文件不认识渠道与 HTTP：只吃分片、吐事件。
 */

import { randomUUID } from 'node:crypto'
import type {
  AssistantContentBlock,
  ContentBlockDelta,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  OutputBlockStart,
  StopReason,
  UserContentBlock,
} from './types.ts'

// ---------- 上游 OpenAI 形状 ----------

/** 上游 Chat Completions 流式分片：只保留本应用消费的字段。 */
export type OpenAiChunk = {
  choices?: {
    delta?: {
      content?: string | null
      /** DeepSeek 与多数中转站的思考字段 */
      reasoning_content?: string | null
      /** 另一些上游的别名 */
      reasoning?: string | null
    } | null
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
    /** 少数中转站沿用 Anthropic 命名 */
    input_tokens?: number | null
    output_tokens?: number | null
  } | null
}

/** 上游 content 的分片：纯文本，或内联图片（data URL）。 */
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * 上游消息：没有图片时 content 用字符串（老上游对 content 数组的兼容性并不一致），
 * 带图片时才用分片数组。
 */
export type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAiContentPart[]
}

/** 附件块的解析结果：由 routes/chat.ts 读盘 / 解包后提供，本文件不做任何 I/O。 */
export type ResolvedFile =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  /** 明确不注入（例如本轮文档字数预算已耗尽）：既不塞正文，也不退回 [附件: id] 占位 */
  | { kind: 'skip' }

/** 按 file_id 取解析结果；返回 null 表示没有可用结果，退回文本占位。 */
export type FileResolver = (fileId: string) => ResolvedFile | null

/** 非字符串一律当空，上游与前端都可能塞脏数据。 */
const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// ---------- 请求：DeepSeek MessageParam[] → OpenAI messages ----------

/** latest_reminder 并入 system；空对话时前端也用它兜底显示 */
const REMINDER_INTRO = '以下是用户当前的环境信息（时间、语言、客户端等），回答时按需参考：'

/**
 * 附件的兜底文本：调用方没给解析结果时用它（模型看不了图、文档解析失败、附件已失效等），
 * 保证对话不会因为附件而中断（GOAL.md §9 铁律 3）。
 */
const attachmentPlaceholder = (fileId: string): string => `[附件: ${fileId}]`

/** 文件块的 file_id；结构不对时返回空串（不产生占位）。 */
const fileIdOf = (block: unknown): string => {
  if (!isRecord(block)) {
    return ''
  }
  const source = block.source
  return isRecord(source) ? readString(source.file_id) : ''
}

/** assistant 历史只取 text 块拼接，thinking / 服务端工具块一律丢弃。 */
const assistantText = (blocks: AssistantContentBlock[]): string =>
  blocks.map((block) => (block.type === 'text' ? readString(block.text) : '')).join('')

/**
 * user 历史：text 拼接；image / document 块优先用调用方给的解析结果
 * （图片 → image_url 分片，文档 → 正文文本），拿不到结果时退回文本占位。
 * 没有图片时返回字符串，有图片时返回分片数组。
 */
const userContent = (
  content: string | UserContentBlock[],
  resolve: FileResolver | undefined
): string | OpenAiContentPart[] => {
  if (typeof content === 'string') {
    return content
  }

  const parts: OpenAiContentPart[] = []
  let hasImage = false

  /** 相邻文本合并进同一个分片，减少分片数量 */
  const pushText = (text: string): void => {
    if (text === '') {
      return
    }
    const last = parts.at(-1)
    if (last && last.type === 'text') {
      last.text += text
      return
    }
    parts.push({ type: 'text', text })
  }

  for (const block of content) {
    if (block.type === 'text') {
      pushText(readString(block.text))
      continue
    }
    if (block.type === 'image' || block.type === 'document') {
      const fileId = fileIdOf(block)
      if (fileId === '') {
        continue
      }
      const resolved = resolve?.(fileId) ?? null
      if (resolved === null) {
        pushText(attachmentPlaceholder(fileId))
      } else if (resolved.kind === 'skip') {
        // 调用方明确要求不注入（如预算耗尽）：保持静默，不要退回占位文本
        continue
      } else if (resolved.kind === 'image') {
        parts.push({ type: 'image_url', image_url: { url: resolved.url } })
        hasImage = true
      } else {
        pushText(resolved.text)
      }
      continue
    }
    // thinking / 服务端工具块等：本应用不向上游转发
  }

  if (hasImage) {
    return parts
  }
  // 没有图片就退回字符串：部分中转站不接受 content 数组
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

export type ToOpenAiMessagesInput = {
  system?: string | undefined
  messages: MessageParam[]
  /** 附件解析结果；不传时附件一律是文本占位（与旧行为一致） */
  resolveFile?: FileResolver | undefined
}

/**
 * 消息转换。取舍（GOAL.md §6.3 最后一行）：
 * - latest_reminder 并入 system（保留时间/语言等上下文），而不是直接丢弃；
 *   连续重复的快照只保留一条。
 * - assistant 的 content 是块数组：只拼 type === 'text' 的 text，其余块丢弃；
 *   只剩思考与工具块的轮次没有可发送的正文，整条丢弃。
 * - user 的 content 可以是字符串或块数组：text 拼接，附件按 resolveFile 解析成正文/图片。
 */
export const toOpenAiMessages = (input: ToOpenAiMessagesInput): OpenAiMessage[] => {
  const messages: OpenAiMessage[] = []
  const reminders: string[] = []

  for (const message of input.messages) {
    if (message.role === 'latest_reminder') {
      const snapshot = message.content.trim()
      if (snapshot !== '' && reminders.at(-1) !== snapshot) {
        reminders.push(snapshot)
      }
      continue
    }

    if (message.role === 'assistant') {
      const text = assistantText(message.content)
      if (text !== '') {
        messages.push({ role: 'assistant', content: text })
      }
      continue
    }

    messages.push({ role: 'user', content: userContent(message.content, input.resolveFile) })
  }

  const systemParts: string[] = []
  const system = input.system?.trim() ?? ''
  if (system !== '') {
    systemParts.push(system)
  }
  if (reminders.length > 0) {
    systemParts.push(`${REMINDER_INTRO}\n${reminders.join('\n')}`)
  }

  if (systemParts.length > 0) {
    messages.unshift({ role: 'system', content: systemParts.join('\n\n') })
  }
  return messages
}

// ---------- 响应：事件状态机 ----------

/** 消息 id：不带横线的 UUID（前端只当不透明串）。 */
export const newMessageId = (): string => randomUUID().replaceAll('-', '')

/** 思考块的签名：前端只当不透明串保存，我们不解析也不回传。 */
const signatureOf = (ray: string): string => `ray-sig-${ray}`

export type TranslatorConfig = {
  /** message_start 里的 message.id */
  id: string
  /** 对外展示的公开模型名（不是上游模型名） */
  model: string
  /** 请求编号，用来拼 signature */
  ray: string
  /** 仅在请求开启标题时提供；给了就随 message_delta 下发 */
  title?: string | undefined
  /**
   * 是否把上游的 reasoning 下发成 thinking 块。
   * 大多数上游即使请求里关掉思考也会继续返回 reasoning_content，
   * 用户明确关掉深度思考时必须丢弃，否则界面会凭空多出一块「思考过程」。
   */
  emitThinking?: boolean | undefined
}

type OpenBlock = { index: number; kind: 'text' | 'thinking' }

/**
 * 上游分片 → DeepSeek 事件的状态机。
 * 调用顺序固定：start() → push(chunk)* → finish()；三者对同一个块 index 保持一致。
 */
export class StreamTranslator {
  /** 累计用量：message_start 先发 0，message_delta 用这里的终值（GOAL.md §6.3） */
  readonly usage: MessageUsage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  }

  private readonly config: TranslatorConfig
  /** 当前打开的块；null 表示没有块在写 */
  private open: OpenBlock | null = null
  private nextIndex = 0
  private stopReason: StopReason = 'end_turn'
  private started = false
  private finished = false

  constructor(config: TranslatorConfig) {
    this.config = config
  }

  /** message_start：必须在任何内容事件之前下发；重复调用返回空数组。 */
  start(): MessageStreamEvent[] {
    if (this.started) {
      return []
    }
    this.started = true
    return [
      {
        type: 'message_start',
        message: {
          id: this.config.id,
          model: this.config.model,
          // 上游此时还没给 usage，先发 0，结束时在 message_delta 补全
          usage: { ...this.usage },
        },
      },
    ]
  }

  /** 消费一个上游分片，返回本次应下发的全部事件（可能为空）。 */
  push(chunk: OpenAiChunk): MessageStreamEvent[] {
    if (this.finished) {
      return []
    }
    const events: MessageStreamEvent[] = [...this.start()]

    this.readUsage(chunk)

    const choice = chunk.choices?.[0]
    if (!choice) {
      return events
    }

    const delta = choice.delta ?? {}
    // 先思考后正文：同一帧里两者都可能出现，各自开自己的块
    const reasoning = this.config.emitThinking === false
      ? ''
      : readString(delta.reasoning_content) || readString(delta.reasoning)
    if (reasoning !== '') {
      events.push(...this.pushThinking(reasoning))
    }
    const text = readString(delta.content)
    if (text !== '') {
      events.push(...this.pushText(text))
    }

    const finishReason = choice.finish_reason
    if (typeof finishReason === 'string' && finishReason !== '') {
      // length → max_tokens，其余（stop / tool_calls / content_filter ...）→ end_turn
      this.stopReason = finishReason === 'length' ? 'max_tokens' : 'end_turn'
    }
    return events
  }

  /** 收尾：关块（思考块先补签名）、message_delta、message_stop。幂等。 */
  finish(): MessageStreamEvent[] {
    if (this.finished) {
      return []
    }
    this.finished = true
    const events: MessageStreamEvent[] = [...this.start()]
    events.push(...this.closeBlock())
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: this.stopReason,
        stop_sequence: null,
        ...(this.config.title === undefined ? {} : { title: this.config.title }),
      },
      usage: { ...this.usage },
    })
    events.push({ type: 'message_stop' })
    return events
  }

  /** 思考增量：块没开就先开一个 thinking 块。 */
  private pushThinking(text: string): MessageStreamEvent[] {
    const events = this.ensureBlock('thinking')
    const block = this.open
    if (!block) {
      return events
    }
    events.push({
      type: 'content_block_delta',
      index: block.index,
      delta: { type: 'thinking_delta', thinking: text },
    })
    return events
  }

  /** 正文增量：块没开就先开一个 text 块。 */
  private pushText(text: string): MessageStreamEvent[] {
    const events = this.ensureBlock('text')
    const block = this.open
    if (!block) {
      return events
    }
    events.push({
      type: 'content_block_delta',
      index: block.index,
      delta: { type: 'text_delta', text },
    })
    return events
  }

  /** 切换块：类型不同就关掉旧的、按递增索引开新的；类型相同直接复用。 */
  private ensureBlock(kind: OpenBlock['kind']): MessageStreamEvent[] {
    if (this.open?.kind === kind) {
      return []
    }
    const events = this.closeBlock()
    const index = this.nextIndex
    this.nextIndex += 1
    this.open = { index, kind }
    const contentBlock: OutputBlockStart =
      kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }
    events.push({ type: 'content_block_start', index, content_block: contentBlock })
    return events
  }

  /** 关闭当前块：思考块结束前补一帧 signature_delta，再 content_block_stop。 */
  private closeBlock(): MessageStreamEvent[] {
    const block = this.open
    if (!block) {
      return []
    }
    this.open = null
    const events: MessageStreamEvent[] = []
    if (block.kind === 'thinking') {
      const delta: ContentBlockDelta = {
        type: 'signature_delta',
        signature: signatureOf(this.config.ray),
      }
      events.push({ type: 'content_block_delta', index: block.index, delta })
    }
    events.push({ type: 'content_block_stop', index: block.index })
    return events
  }

  /** 上游 usage 可能出现在任意一帧（多数在最后一帧），见到就覆盖累计值。 */
  private readUsage(chunk: OpenAiChunk): void {
    const usage = chunk.usage
    if (!usage) {
      return
    }
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens
    const outputTokens = usage.completion_tokens ?? usage.output_tokens
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens)) {
      this.usage.input_tokens = inputTokens
    }
    if (typeof outputTokens === 'number' && Number.isFinite(outputTokens)) {
      this.usage.output_tokens = outputTokens
    }
  }
}
