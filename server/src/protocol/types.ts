/**
 * DeepSeek 形状（Anthropic Messages 兼容 + DeepSeek 私有扩展）的协议类型。
 * 摘取自 deepseek-site/src/services/api/types.ts（只读参考），只保留本应用实际收发与产出的部分。
 *
 * 前端 parseEvent.ts 只校验它消费所需的字段，所以这里对「我们不消费的块」做了收窄：
 * 只保留 type 位，其余字段用索引签名承接，避免把前端的全部私有块类型抄一遍。
 */

// ---------- 请求：消息 ----------

export type TextBlockParam = { type: 'text'; text: string }

/** 文件块：图片用 image、其余用 document；source 恒为 Files API 的 file_id。 */
export type FileBlockParam = {
  type: 'image' | 'document'
  source: { type: 'file'; file_id: string }
}

/**
 * 本应用不消费的内容块：thinking / server_tool_use / web_search_tool_result /
 * web_fetch_tool_result / tool_use 等，一律丢弃。
 */
export type OtherBlockParam = { type: string; [key: string]: unknown }

/** user 消息的内容块：只有 text 与文件块有意义。 */
export type UserContentBlock = TextBlockParam | FileBlockParam | OtherBlockParam

/** assistant 消息的内容块：只取 text，思考与服务端工具块丢弃。 */
export type AssistantContentBlock = TextBlockParam | OtherBlockParam

/** 一条历史消息；latest_reminder 是 Chat Engine 扩展角色，位于对应 user 之前。 */
export type MessageParam =
  | { role: 'latest_reminder'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }

/** 联网工具声明：M1 不接检索，收到即忽略。 */
export type ToolParam = { type: string; [key: string]: unknown }

/**
 * POST /api/chat 的请求体 = 前端 CreateMessageRequest + stream 开关。
 * model 是 Ray 自己的公开模型名，不是上游模型名；其余字段按前端原样收下。
 */
export type CreateMessageRequest = {
  model: string
  system?: string
  messages: MessageParam[]
  thinking?: { type: 'enabled' | 'disabled'; [key: string]: unknown }
  tools?: ToolParam[]
  safety_check?: { level: string; [key: string]: unknown }
  title?: { enabled: boolean; [key: string]: unknown }
  /** 前端恒为 true；BFF 只实现流式 */
  stream?: boolean
}

// ---------- 响应：内容块 ----------

/** 正文引用：M1 没有检索，恒不产出，仅为对齐前端类型保留。 */
export type TextCitation = {
  type: 'web_search_result_location'
  url: string
  /** 查不到标题时为 null */
  title: string | null
  /** 当前文本块截至该引用处的全部正文 */
  cited_text: string
  /** 恒为空串 */
  encrypted_index: string
}

/** 文本块：挂过引用的块之后，后续正文另起新块。 */
export type TextBlock = { type: 'text'; text: string; citations?: TextCitation[] }

/** 思考块：签名在块结束前经 signature_delta 下发，值为本次响应的不透明串。 */
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }

/** content_block_start 携带的初始思考块：signature 由随后的 signature_delta 补齐，故此处可省。 */
export type ThinkingBlockStart = Omit<ThinkingBlock, 'signature'> & { signature?: string }

/** content_block_start 携带的初始块；工具块 M1 不产出。 */
export type OutputBlockStart = TextBlock | ThinkingBlockStart

/** 本应用会下发的内容增量（citations_delta / input_json_delta 对应能力 M1 不产出）。 */
export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

export type MessageUsage = {
  /** 未命中缓存的输入 Token */
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** message_start 中为 0，message_delta 中为全轮累计值 */
  output_tokens: number
}

/** 流式事件：SSE 的 event 名与 JSON 的 type 相同，以 message_stop 结束，不发送 [DONE]。 */
export type MessageStreamEvent =
  | {
      type: 'message_start'
      /** id 为不带 msg_ 前缀的 UUID */
      message: { id: string; model: string; usage?: MessageUsage }
    }
  | { type: 'content_block_start'; index: number; content_block: OutputBlockStart }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      /** title 仅在请求开启标题且生成成功时出现 */
      delta: { stop_reason: StopReason; stop_sequence: null; title?: string }
      usage?: MessageUsage
    }
  | { type: 'message_stop' }
  | { type: 'ping' }

/** 流内错误帧 / 非 2xx 响应体；前端只读 error.message。 */
export type ApiErrorBody = { error: { message: string; type?: string } }
