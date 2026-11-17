import { env } from '../env.ts'

/**
 * 本地关键词审核（GOAL.md §9 #10 的免费兜底）。
 *
 * 刻意做成「配置驱动」：默认不内置任何词表——通用站点不该由代码决定什么算违规，
 * 也不该把可能误伤的词硬编码进去。运营方通过 RAY_MODERATION_KEYWORDS 提供自己的清单
 * （英文逗号分隔），未配置时纯透传并在启动时提示一次。
 *
 * 匹配方式：统一小写、去掉所有空白后做子串包含，避免"关 键 词"这类简单绕过。
 */
export type ModerationVerdict = { blocked: boolean; hit?: string }

let announced = false
let cachedRaw: string | undefined
let cachedKeywords: string[] = []

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/gu, '')

const keywords = (): string[] => {
  const raw = env.RAY_MODERATION_KEYWORDS ?? ''
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedKeywords = raw
      .split(',')
      .map((item) => normalize(item))
      .filter((item) => item.length > 0)
  }
  if (!announced) {
    announced = true
    if (cachedKeywords.length === 0) {
      console.info('[zhds] 未配置 RAY_MODERATION_KEYWORDS，内容审核为透传模式')
    }
  }
  return cachedKeywords
}

export const moderateText = (text: string): ModerationVerdict => {
  const list = keywords()
  if (list.length === 0 || text.length === 0) {
    return { blocked: false }
  }
  const haystack = normalize(text)
  for (const keyword of list) {
    if (haystack.includes(keyword)) {
      return { blocked: true, hit: keyword }
    }
  }
  return { blocked: false }
}
