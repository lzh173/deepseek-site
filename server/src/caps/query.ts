import type { FastifyInstance } from 'fastify'
import type { FastifyBaseLogger } from 'fastify'
import { pickKey, reportKey } from '../pool/index.ts'
import type { SessionUser } from '../lib/user.ts'
import { normalizeQuery } from './search.ts'

/**
 * 让模型自己产出搜索词，而不是从用户句子里切词。
 *
 * 为什么必须这么做：用户说的是「请你搜索icom7300」，中文分词会把「请」当成关键词，
 * 返回一堆「请」字释义页。任何基于规则的前缀剥离都只是补丁——真正知道该搜什么的是模型。
 *
 * 实现上是一次**短的非流式请求**：用同一把 Key 问模型「该搜什么」，拿到 1~3 条查询词，
 * 再去真正检索。代价是一次很短的往返（实测 0.5~1.5 秒），换来的是查询质量。
 * 失败或超时一律退回规则归一化，保证搜索功能不会因此不可用。
 */

const PLAN_TIMEOUT_MS = 25_000
const MAX_PLANNED_QUERIES = 3

const SYSTEM_PROMPT = [
  '你是搜索查询生成器。根据用户的消息，生成 1-3 条最适合交给搜索引擎的查询词。',
  '',
  '要求：',
  '- 每行一条，只输出查询词本身，不要编号、不要解释、不要引号。',
  '- 去掉「请」「帮我」「搜索」「查一下」这类指令词。',
  '- **第一条必须是规范化后的完整查询**：补上品牌/型号的标准写法与类别词。',
  '  例如用户写「icom7300」，应输出「ICOM IC-7300 短波电台」而不是「icom7300」——',
  '  搜索引擎对连写的型号召回很差，加上品牌与类别才能找到对的页面。',
  '- 需要时再给 1-2 条变体（如加「评测」「价格」「参数」），覆盖不同意图。',
  '- 如果是寒暄、闲聊、纯指令（例如「你好」「继续」），输出空。',
].join('\n')

const fallback = (text: string): string[] => {
  // 计划失败也要归一化：否则「请你搜索icom7300」会原样进搜索引擎。
  const trimmed = normalizeQuery(text).slice(0, 200)
  return trimmed === '' ? [] : [trimmed]
}

const parsePlan = (raw: string): string[] => {
  const queries: string[] = []
  for (const line of raw.split(/\r?\n/u)) {
    const cleaned = line
      .replace(/^[\s\-*•\d.、)）]+/u, '')
      .replace(/^["'「『]|["'」』]$/gu, '')
      .replace(/[。；;]+$/u, '')
      .trim()
    if (cleaned === '' || cleaned.length > 200) {
      continue
    }
    if (!queries.includes(cleaned)) {
      queries.push(cleaned)
    }
    if (queries.length >= MAX_PLANNED_QUERIES) {
      break
    }
  }
  return queries
}

/**
 * 短查询且没有指令词时不需要额外问模型：
 * 「warthunder」「icom7300 价格」这类本身就是合格的搜索词，
 * 多一次上游往返只会白白多等几秒（官方接口单次就要 8 秒上下）。
 */
const INSTRUCTION = /请|帮|麻烦|搜|查|找|看看|了解|介绍|怎么样|如何|为什么|是什么|推荐|对比/u

const needsPlanning = (text: string): boolean => text.length > 24 || INSTRUCTION.test(text)

export const planSearchQueries = async (input: {
  app: FastifyInstance
  user: SessionUser
  publicModel: string
  userText: string
  ray: string
  signal: AbortSignal
  log: FastifyBaseLogger
}): Promise<string[]> => {
  const text = input.userText.trim()
  if (text === '') {
    return []
  }
  if (!needsPlanning(text)) {
    return fallback(text)
  }

  let pick
  try {
    pick = await pickKey(input.app, { publicModel: input.publicModel, user: input.user })
  } catch (error) {
    input.log.warn({ err: error, ray: input.ray }, '生成搜索词前没有可用 Key，退回规则归一化')
    return fallback(text)
  }

  const started = Date.now()
  try {
    const response = await fetch(`${pick.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pick.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: pick.upstreamModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, 2_000) },
        ],
        stream: false,
        temperature: 0,
        max_tokens: 80,
        // 关掉思考：这一步只要短查询词，思考模式会显著拖慢
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]),
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      input.log.warn({ ray: input.ray, status: response.status }, '生成搜索词失败，退回规则归一化')
      return fallback(text)
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    reportKey(input.app, pick, {
      ok: true,
      ms: Date.now() - started,
      inTok: body.usage?.prompt_tokens ?? 0,
      outTok: body.usage?.completion_tokens ?? 0,
    })

    const planned = parsePlan(body.choices?.[0]?.message?.content ?? '')
    if (planned.length === 0) {
      input.log.info({ ray: input.ray, ms: Date.now() - started }, '模型判断无需检索')
      return []
    }
    input.log.info(
      { ray: input.ray, queries: planned, ms: Date.now() - started },
      '模型生成了搜索词'
    )
    return planned
  } catch (error) {
    // 规划是**辅助步骤**：它超时/失败不应该把 Key 打进冷却，
    // 否则真正该跑的那次请求会因为没有可用 Key 而 503。
    input.log.warn({ err: error, ray: input.ray }, '生成搜索词超时/失败，退回规则归一化')
    return fallback(text)
  }
}
