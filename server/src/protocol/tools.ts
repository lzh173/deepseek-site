/**
 * 服务端工具块（GOAL.md §6.3、§9 #4/#5）：把检索与读链接的结果包装成
 * 前端 parseEvent.ts 认识的 DeepSeek 扩展块。
 *
 * 字段一个都不能少：parseEvent.ts 的 readBlock() 会逐字段校验，
 * 任一字段缺失或类型不对，整块会被前端静默丢弃（表现为「工具块消失」）。
 */

import type { MessageStreamEvent } from './types.ts'
import type { ReadResult } from '../caps/reader.ts'
import type { SearchHit } from '../caps/search.ts'

// ---------- 块类型 ----------

/** 检索调用块：content_block_start 即携带完整 input（与 DeepSeek 原协议一致） */
export type SearchToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'deepseek_web_search'
  input: { action: 'search'; queries: string[] }
  caller: { type: 'direct' }
  kind: 'search'
}

/** 一条可展示的检索结果；site_name / page_age 允许为 null */
export type WebSearchResultItem = {
  type: 'web_search_result'
  title: string
  url: string
  snippet: string
  site_name: string | null
  site_icon: string | null
  /** 前端只当不透明串保存；我们没有加密索引，按协议填入空串 */
  encrypted_content: string
  page_age: string | null
}

/** 检索失败项：content 只含这一项时前端显示「检索不可用」 */
export type WebSearchErrorItem = {
  type: 'web_search_tool_result_error'
  error_code: 'unavailable'
}

export type SearchToolResultBlock = {
  type: 'web_search_tool_result'
  tool_use_id: string
  kind: 'search'
  content: (WebSearchResultItem | WebSearchErrorItem)[]
}

/** 读链接调用块 */
export type ReadToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'deepseek_read_url'
  input: { action: 'read_link'; url: string }
  caller: { type: 'direct' }
  kind: 'read_link'
}

export type ReadToolResultBlock = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  kind: 'read_link'
  content: {
    type: 'web_fetch_result'
    url: string
    content: {
      type: 'document'
      source: { type: 'text'; media_type: 'text/plain'; data: string }
      title: string | null
    }
    published_at: string | null
  }
}

export type ToolBlock =
  | SearchToolUseBlock
  | SearchToolResultBlock
  | ReadToolUseBlock
  | ReadToolResultBlock

// ---------- id ----------

/** 检索调用 id：一轮对话只检索一次，序号恒为 1 */
export const searchToolUseId = (ray: string): string => `srvtoolu_s_${ray}_1`

/** 读链接调用 id：同一轮可能读多个链接，用序号区分，避免前端按 id 配对时串台 */
export const readToolUseId = (ray: string, seq = 1): string => `srvtoolu_rl_${ray}_${seq}`

// ---------- 构造 ----------

export const searchToolUse = (ray: string, queries: string[]): SearchToolUseBlock => ({
  type: 'server_tool_use',
  id: searchToolUseId(ray),
  name: 'deepseek_web_search',
  input: { action: 'search', queries },
  caller: { type: 'direct' },
  kind: 'search',
})

export const searchToolResult = (toolUseId: string, hits: SearchHit[]): SearchToolResultBlock => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  kind: 'search',
  content: hits.map((hit) => ({
    type: 'web_search_result',
    title: hit.title,
    url: hit.url,
    snippet: hit.snippet,
    site_name: hit.siteName,
    site_icon: null,
    encrypted_content: '',
    page_age: hit.pageAge,
  })),
})

/** 检索不可用：只含一个 error 项，前端据此把搜索步骤标成失败 */
export const searchToolResultError = (toolUseId: string): SearchToolResultBlock => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  kind: 'search',
  content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
})

export const readToolUse = (ray: string, url: string, seq = 1): ReadToolUseBlock => ({
  type: 'server_tool_use',
  id: readToolUseId(ray, seq),
  name: 'deepseek_read_url',
  input: { action: 'read_link', url },
  caller: { type: 'direct' },
  kind: 'read_link',
})

export const readToolResult = (toolUseId: string, result: ReadResult): ReadToolResultBlock => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  kind: 'read_link',
  content: {
    type: 'web_fetch_result',
    url: result.url,
    content: {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: result.text },
      title: result.title,
    },
    published_at: result.publishedAt,
  },
})

// ---------- 事件 ----------

/**
 * 工具块是原子下发的：content_block_start 带完整内容，紧接一个 content_block_stop。
 *
 * protocol/types.ts 的 OutputBlockStart 只声明了 M1 会产出的文本/思考块，
 * 所以这里做一次显式断言；前端 parseEvent.ts 对工具块的字段校验才是真正的契约。
 */
export const toToolBlockEvents = (blocks: ToolBlock[]): MessageStreamEvent[] => {
  const events: MessageStreamEvent[] = []
  blocks.forEach((block, index) => {
    events.push({
      type: 'content_block_start',
      index,
      content_block: block,
    } as unknown as MessageStreamEvent)
    events.push({ type: 'content_block_stop', index })
  })
  return events
}
