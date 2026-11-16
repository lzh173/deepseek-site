/**
 * 联网搜索兜底（GOAL.md §9 #4）：SearXNG → DuckDuckGo HTML 抓取 → 空结果。
 *
 * 硬约定：本模块永不抛错。检索挂了只让对话退化成普通对话（§9 铁律 3），
 * 要不要下发「检索不可用」的工具块由路由层决定；这里最多返回空数组。
 */

import { fetch, type Response } from 'undici'
import { env } from '../env.ts'

/** 一条检索结果；siteName / pageAge 允许为空（前端会自己从 URL 推站点名） */
export type SearchHit = {
  title: string
  url: string
  snippet: string
  siteName: string | null
  pageAge: string | null
}

/** 一次搜索的总时限：超过就按「没有结果」处理（§9 #4 要求 8 秒） */
const TIMEOUT_MS = 10_000
/** 单页最多读这么多字节：兜底抓取可能碰到超大页面，只取前段 */
const MAX_BODY_BYTES = 1_000_000
/** 前端来源面板最多展示的条数 */
const MAX_HITS = 6
/** 单轮最多接受几个查询：本应用只传一个，这里防滥用 */
const MAX_QUERIES = 4
/** DDG 的 html 端点对空 UA 会直接拒绝，伪装成普通浏览器 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 折叠空白：搜索结果里的标题与摘要都是单行文本 */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, ' ')

// ---------- HTML 实体 ----------

/** 只覆盖搜索结果里会出现的常见实体；不认识的保持原样 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

/** 数字实体与具名实体解码；非法码点原样保留，避免把整段文本吞掉 */
export const decodeEntities = (text: string): string =>
  text.replace(ENTITY_RE, (whole: string, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[body] ?? whole
  })

// ---------- 小工具 ----------

/** 只接受 http(s) 的绝对地址；其余（javascript:、相对路径）一律丢弃 */
const absoluteHttpUrl = (raw: string): string | null => {
  const text = raw.trim()
  if (text === '') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  return parsed.toString()
}

/** 限制读取字节数，避免被超大页面拖住；连接由 finally 释放 */
const readBodyText = async (response: Response, maxBytes: number): Promise<string> => {
  const body = response.body
  if (!body) {
    return ''
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 连接可能已经被对端关闭
    }
  }
  return Buffer.concat(chunks, Math.min(total, maxBytes)).toString('utf8')
}

/** 单个搜索源失败不向外冒泡：调用方只关心「有没有结果」 */
const attempt = async (run: () => Promise<SearchHit[]>): Promise<SearchHit[]> => {
  try {
    return await run()
  } catch {
    return []
  }
}

// ---------- SearXNG ----------

/**
 * SearXNG 的 JSON 接口：`GET {url}/search?q=&format=json&language=zh-CN`，
 * 结果取 `results[].{title,url,content,publishedDate}`。
 */
const searchSearxng = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const base = env.RAY_SEARXNG_URL
  if (!base) {
    return []
  }
  const endpoint = new URL(`${base.replace(/\/+$/, '')}/search`)
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('format', 'json')
  endpoint.searchParams.set('language', 'zh-CN')

  const response = await fetch(endpoint, {
    method: 'GET',
    signal,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`SearXNG 返回 ${response.status}`)
  }

  const raw = await readBodyText(response, MAX_BODY_BYTES)
  const payload: unknown = JSON.parse(raw)
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return []
  }

  const hits: SearchHit[] = []
  for (const item of payload.results) {
    if (!isRecord(item)) {
      continue
    }
    const url = absoluteHttpUrl(readString(item.url))
    if (!url) {
      continue
    }
    const title = collapse(stripTags(readString(item.title)))
    const snippet = collapse(stripTags(readString(item.content)))
    const published = readString(item.publishedDate).trim()
    hits.push({
      title: title === '' ? url : title,
      url,
      snippet,
      // SearXNG 不提供站点名，前端会从域名兜底
      siteName: null,
      pageAge: published === '' ? null : published,
    })
  }
  return hits
}

// ---------- DuckDuckGo HTML 兜底 ----------

/** 属性值：DDG 的模板单双引号都可能出现 */
const attributeOf = (attrs: string, name: string): string => {
  const matched = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  if (!matched) {
    return ''
  }
  return matched[2] ?? matched[3] ?? ''
}

const classOf = (attrs: string): string => attributeOf(attrs, 'class')

const hasClass = (attrs: string, name: string): boolean =>
  classOf(attrs).split(/\s+/).includes(name)

/**
 * DDG 的跳转链接形如 `//duckduckgo.com/l/?uddg=<百分号编码的真实地址>`，
 * 普通结果则直接是绝对地址。
 */
const realUrlOf = (href: string): string | null => {
  const raw = decodeEntities(href).trim()
  if (raw === '') {
    return null
  }
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw
  let parsed: URL
  try {
    parsed = new URL(candidate, 'https://duckduckgo.com')
  } catch {
    return null
  }
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
    const target = parsed.searchParams.get('uddg')
    return target === null ? null : absoluteHttpUrl(target)
  }
  return absoluteHttpUrl(parsed.toString())
}

type RawAnchor = { start: number; href: string; title: string }
type RawSnippet = { start: number; text: string }

/** 取某个开标签的内容：截到同名的第一个闭标签为止（摘要里只会出现行内标签） */
const innerOf = (html: string, tagName: string, contentStart: number): string => {
  const close = new RegExp(`</${tagName}\\s*>`, 'i').exec(html.slice(contentStart))
  return close === null ? '' : html.slice(contentStart, contentStart + close.index)
}

/**
 * 从结果页里取出 `result__a` 标题锚点与 `result__snippet` 摘要。
 * 摘要在不同版本的 DDG 模板里既可能是 <a> 也可能是 <div>，所以按「带 class 的开标签」找。
 */
const parseDuckDuckGo = (html: string): SearchHit[] => {
  const anchors: RawAnchor[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
  for (let matched = anchorRe.exec(html); matched !== null; matched = anchorRe.exec(html)) {
    const attrs = matched[1] ?? ''
    if (!hasClass(attrs, 'result__a')) {
      continue
    }
    anchors.push({
      start: matched.index,
      href: attributeOf(attrs, 'href'),
      title: collapse(decodeEntities(stripTags(matched[2] ?? ''))),
    })
  }

  const snippets: RawSnippet[] = []
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi
  for (let matched = openTagRe.exec(html); matched !== null; matched = openTagRe.exec(html)) {
    const tagName = matched[1] ?? ''
    const attrs = matched[2] ?? ''
    if (tagName === '' || !hasClass(attrs, 'result__snippet')) {
      continue
    }
    snippets.push({
      start: matched.index,
      text: collapse(decodeEntities(stripTags(innerOf(html, tagName, openTagRe.lastIndex)))),
    })
  }

  const hits: SearchHit[] = []
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]
    if (!anchor) {
      continue
    }
    const url = realUrlOf(anchor.href)
    if (!url) {
      continue
    }
    // 摘要属于「当前标题之后、下一个标题之前」的那一段
    const nextStart = anchors[index + 1]?.start ?? html.length
    const snippet = snippets.find((item) => item.start > anchor.start && item.start < nextStart)
    hits.push({
      title: anchor.title === '' ? url : anchor.title,
      url,
      snippet: snippet?.text ?? '',
      siteName: null,
      pageAge: null,
    })
  }
  return hits
}

/**
 * Bing 的结果链接有时是 `bing.com/ck/a?…&u=a1<base64url>` 的跳转壳，
 * `u` 去掉前缀 `a1` 后做 base64url 解码就是真实地址。
 */
const realBingUrl = (href: string): string | null => {
  if (href === '') {
    return null
  }
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(absolute, 'https://www.bing.com')
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname.startsWith('/ck/a')) {
      const target = parsed.searchParams.get('u') ?? ''
      if (target.startsWith('a1')) {
        const padded = target.slice(2).replace(/-/gu, '+').replace(/_/gu, '/')
        try {
          const decoded = Buffer.from(padded, 'base64').toString('utf8')
          return decoded.startsWith('http') ? decoded : null
        } catch {
          return null
        }
      }
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

/** Bing 结果块：`<li class="b_algo">` 里依次是 `<h2><a href>标题</a></h2>` 与 `<p>摘要</p>` */
const parseBing = (html: string): SearchHit[] => {
  const hits: SearchHit[] = []
  const blocks = html.split(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/iu)
  for (let index = 1; index < blocks.length; index += 1) {
    const block = blocks[index] ?? ''
    const titleMatch = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a\s*>/iu.exec(block)
    if (!titleMatch) {
      continue
    }
    const url = realBingUrl(attributeOf(titleMatch[1] ?? '', 'href'))
    if (!url) {
      continue
    }
    const title = collapse(decodeEntities(stripTags(titleMatch[2] ?? '')))
    const snippetMatch = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/iu.exec(block)
    const snippet = snippetMatch ? collapse(decodeEntities(stripTags(snippetMatch[1] ?? ''))) : ''
    hits.push({
      title: title === '' ? url : title,
      url,
      snippet,
      siteName: null,
      pageAge: null,
    })
    if (hits.length >= MAX_HITS) {
      break
    }
  }
  return hits
}

const searchBing = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const endpoint = new URL('https://www.bing.com/search')
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('setlang', 'zh-CN')

  const response = await fetch(endpoint, {
    method: 'GET',
    signal,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': USER_AGENT,
    },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Bing 返回 ${response.status}`)
  }
  return parseBing(await readBodyText(response, MAX_BODY_BYTES))
}

const searchDuckDuckGo = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const endpoint = new URL('https://html.duckduckgo.com/html/')
  endpoint.searchParams.set('q', query)

  const response = await fetch(endpoint, {
    method: 'GET',
    signal,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': USER_AGENT,
    },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`DuckDuckGo 返回 ${response.status}`)
  }
  return parseDuckDuckGo(await readBodyText(response, MAX_BODY_BYTES))
}

// ---------- 对外入口 ----------

/** 单个查询：SearXNG 优先，未配置或失败时走 Bing，再退到 DDG 抓取 */
const searchOne = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  if (signal.aborted) {
    return []
  }
  if (env.RAY_SEARXNG_URL) {
    const fromSearxng = await attempt(() => searchSearxng(query, signal))
    if (fromSearxng.length > 0) {
      return fromSearxng
    }
    if (signal.aborted) {
      return []
    }
  }
  // Bing 在境内通常可达，作为无 SearXNG 时的第一兜底。
  // 注意区分「请求失败」与「确实没有结果」：前者才继续退 DDG，否则白白多等一个超时。
  try {
    return await searchBing(query, signal)
  } catch {
    if (signal.aborted) {
      return []
    }
    return attempt(() => searchDuckDuckGo(query, signal))
  }
}

/**
 * 预热：进程刚起来时到 bing.com 的首次 TLS 握手可能超过搜索预算（实测冷启动 ~8s），
 * 先发一个只建连、不读正文的请求，后续真实搜索就能落在一秒内。
 * 失败无所谓，纯粹是性能优化。
 */
export const warmupSearch = (): void => {
  void fetch('https://www.bing.com/', { headers: { 'user-agent': USER_AGENT } })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
}

/**
 * 联网搜索：多个 query 依次查询、按 url 去重，最多 6 条。
 * 任何失败（未配置、超时、HTTP 错误、解析失败）都返回 []，绝不抛错。
 */
export const searchWeb = async (queries: string[], signal?: AbortSignal): Promise<SearchHit[]> => {
  const list: string[] = []
  for (const raw of queries) {
    const query = raw.trim()
    if (query !== '' && !list.includes(query)) {
      list.push(query)
    }
    if (list.length >= MAX_QUERIES) {
      break
    }
  }
  if (list.length === 0) {
    return []
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('搜索超时')), TIMEOUT_MS)
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  try {
    const hits: SearchHit[] = []
    const seen = new Set<string>()
    for (const query of list) {
      const found = await searchOne(query, controller.signal)
      for (const hit of found) {
        if (seen.has(hit.url)) {
          continue
        }
        seen.add(hit.url)
        hits.push(hit)
        if (hits.length >= MAX_HITS) {
          return hits
        }
      }
    }
    return hits
  } catch {
    // 兜底中的兜底：任何意外都退化成「没有结果」
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
