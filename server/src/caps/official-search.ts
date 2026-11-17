import type { FastifyInstance } from 'fastify'
import { decryptSecret } from '../lib/crypto.ts'
import { env } from '../env.ts'

/**
 * DeepSeek 官方 Search / Fetch 接口。
 *
 * 为什么优先用它：5 元 / 1000 次（且**失败与空结果不计费**），返回的是经过重排的结构化结果
 * （rerank_score / summary / site_name / date / authority），比我们抓 Bing HTML 稳得多，
 * 也不会被反爬拦。代价是要消耗官方 Key——所以只在**存在官方渠道 Key**时启用，
 * 没有就退回本地抓取（caps/search.ts 的链路）。
 *
 * 关键点：这是**账号级**能力，与当前对话用的是哪个模型无关；
 * 所以即使用户选了免费中转站的模型，也能享受官方搜索。
 */

const SEARCH_PATH = '/v1/tools/search'
const FETCH_PATH = '/v1/tools/fetch'
const SEARCH_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 20_000

export type OfficialSearchHit = {
  title: string
  url: string
  snippet: string
  /** 长摘要（600~800 字），喂给模型比 snippet 更有用 */
  summary: string
  siteName: string | null
  siteIcon: string | null
  pageAge: string | null
  /** 0~3，≥1.5 视为优质；用于过滤与排序 */
  rerankScore: number
  authority: number
}

export type OfficialFetchResult = {
  title: string
  url: string
  content: string
}

type OfficialCredential = { baseUrl: string; secret: string }

/**
 * 从渠道表里找一把可用的官方 Key。
 * 官方渠道（official = 1）优先；没有就退而求其次用 base_url 指向 api.deepseek.com 的渠道。
 */
const findOfficialCredential = (app: FastifyInstance): OfficialCredential | null => {
  const rows = app.db
    .prepare(
      `SELECT c.base_url, k.key_cipher
       FROM keys k JOIN channels c ON c.id = k.channel_id
       WHERE c.enabled = 1 AND k.status = 'active'
         AND (c.official = 1 OR c.base_url LIKE '%api.deepseek.com%')
       ORDER BY c.official DESC, c.priority ASC
       LIMIT 1`
    )
    .all() as { base_url: string; key_cipher: string }[]

  const row = rows[0]
  if (!row) {
    return null
  }
  try {
    return {
      baseUrl: (env.RAY_OFFICIAL_BASE_URL ?? row.base_url).replace(/\/+$/, ''),
      secret: decryptSecret(row.key_cipher),
    }
  } catch {
    // 密文损坏（主密钥换过）时不要拖垮搜索，退回本地抓取
    return null
  }
}

/** 是否配置了可用的官方 Key —— 调用方据此决定走官方还是本地 */
export const hasOfficialSearch = (app: FastifyInstance): boolean =>
  findOfficialCredential(app) !== null

const post = async (
  credential: OfficialCredential,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> => {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) {
    signals.push(signal)
  }
  return fetch(`${credential.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
}

type RawResult = {
  rerank_score?: number
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  site_name?: string | null
  site_icon?: string | null
  date?: string | null
  authority?: number
}

/**
 * 官方搜索：一次请求可以拿多条结果，且按 query 语义重排过。
 * 失败返回 []，不抛错（与本地链路一致的约定）。
 */
export const officialSearch = async (
  app: FastifyInstance,
  query: string,
  options: { count?: number; originalQuestion?: string; signal?: AbortSignal } = {}
): Promise<OfficialSearchHit[]> => {
  const credential = findOfficialCredential(app)
  if (!credential || query.trim() === '') {
    return []
  }

  const body: Record<string, unknown> = {
    query: query.slice(0, 128),
    count: Math.min(Math.max(options.count ?? 8, 1), 50),
    need_content: false,
  }
  if (options.originalQuestion) {
    body.ori_question = options.originalQuestion.slice(0, 128)
  }

  try {
    const response = await post(credential, SEARCH_PATH, body, SEARCH_TIMEOUT_MS, options.signal)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      app.log.warn({ status: response.status, query }, '官方搜索失败，退回本地抓取')
      return []
    }
    const payload = (await response.json()) as { results?: RawResult[] }
    const results = Array.isArray(payload.results) ? payload.results : []
    return results
      .filter((item): item is RawResult & { url: string } => typeof item.url === 'string')
      .map((item) => ({
        title: item.title?.trim() || item.url,
        url: item.url,
        snippet: item.snippet?.trim() ?? '',
        summary: item.summary?.trim() ?? '',
        siteName: item.site_name ?? null,
        siteIcon: item.site_icon ?? null,
        pageAge: item.date ?? null,
        rerankScore: typeof item.rerank_score === 'number' ? item.rerank_score : 0,
        authority: typeof item.authority === 'number' ? item.authority : -1,
      }))
  } catch (error) {
    app.log.warn({ err: error, query }, '官方搜索异常，退回本地抓取')
    return []
  }
}

/** 官方抓取：返回 Markdown 正文，比本地去标签抽取干净得多 */
export const officialFetch = async (
  app: FastifyInstance,
  url: string,
  signal?: AbortSignal
): Promise<OfficialFetchResult | null> => {
  const credential = findOfficialCredential(app)
  if (!credential) {
    return null
  }
  try {
    const response = await post(credential, FETCH_PATH, { url }, FETCH_TIMEOUT_MS, signal)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      app.log.warn({ status: response.status, url }, '官方抓取失败，退回本地抽取')
      return null
    }
    const payload = (await response.json()) as { title?: string; content?: string }
    if (typeof payload.content !== 'string' || payload.content.trim() === '') {
      return null
    }
    return {
      title: payload.title?.trim() || url,
      url,
      content: payload.content,
    }
  } catch (error) {
    app.log.warn({ err: error, url }, '官方抓取异常，退回本地抽取')
    return null
  }
}
