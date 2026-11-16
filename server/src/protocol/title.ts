/**
 * 本地启发式标题（GOAL.md §9 #3 的免费兜底）。
 * 取最后一条 user 消息的纯文本，去掉 Markdown 标记与换行后截断 20 个字符。
 * 纯本地计算，不调用任何模型，也不产生任何上游请求。
 */

import type { MessageParam, UserContentBlock } from './types.ts'

/** 标题最多保留的字符数；按码点截断，避免把 emoji 劈成半个 */
const MAX_TITLE_LENGTH = 20

/** 没有可用文本时的标题，与前端空会话的默认显示一致 */
const EMPTY_TITLE = '新对话'

/** 只在 user 消息是块数组时用到：只取 text 块，附件块不参与标题。 */
const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

const blockText = (content: string | UserContentBlock[]): string => {
  if (typeof content === 'string') {
    return content
  }
  return content.map((block) => (block.type === 'text' ? readString(block.text) : '')).join('')
}

/** 去掉常见 Markdown 标记：代码块、行内代码、图片、链接、标题、引用、列表、强调符号。 */
const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d{1,3}[.)][ \t]+/gm, '')
    // 残余的强调 / 删除线 / 代码标记；启发式清理，不做完整 Markdown 解析
    .replace(/[*_~`]/g, '')
    // 换行与连续空白压成一个空格
    .replace(/\s+/g, ' ')
    .trim()

const truncate = (text: string): string => {
  const chars = Array.from(text)
  return chars.length > MAX_TITLE_LENGTH ? chars.slice(0, MAX_TITLE_LENGTH).join('') : text
}

/** 最后一条 user 消息的纯文本；没有则返回空串。 */
const lastUserText = (messages: MessageParam[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      return blockText(message.content)
    }
  }
  return ''
}

/**
 * 生成标题：清理后截断到 20 个字符，空则用「新对话」。
 * 调用方只在 body.title.enabled 为 true 时才把结果放进 message_delta.delta.title。
 */
export const deriveTitle = (messages: MessageParam[]): string => {
  const title = truncate(stripMarkdown(lastUserText(messages)))
  return title === '' ? EMPTY_TITLE : title
}
