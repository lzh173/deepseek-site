/**
 * 联网搜索兜底（GOAL.md §9 #4）。
 *
 * 链路（境内实测后定的顺序）：
 *   SearXNG（可选自建）→ 360 → 百度 → Bing RSS → Bing HTML → DuckDuckGo（保底，境内基本废）
 *
 * 单选型策略：360 与百度并行竞速，谁先给出 ≥3 条就用谁，都不够就合并两者；
 * Bing RSS 只要 500ms 左右、结构简单，放在 HTML 版本前面。
 * 不用公共 SearXNG 实例（全线超时）、不用 Sogou（回验证码页）、DDG（html/lite）在这台机器上完全超时。
 *
 * 硬约定：本模块永不抛错。检索挂了只让对话退化成普通对话（§9 铁律 3），
 * 要不要下发「检索不可用」的工具块由路由层决定；这里最多返回空数组。
 */

import { env } from '../env.ts'

/** 一条检索结果；siteName / pageAge 允许为空（前端会自己从 URL 推站点名） */
export type SearchHit = {
  title: string
  url: string
  snippet: string
  siteName: string | null
  pageAge: string | null
}

/** 一次搜索的总预算：超过就按「没有结果」处理（§9 #4 要求 8 秒内给答复） */
const TIMEOUT_MS = 8_000
/** 留给「中止后各源收尾」的余量：真掐在 8000ms 上返回会略微超预算 */
const ABORT_RESERVE_MS = 300
/** 360 / 百度 各自的时限：到点没结果就当这家没有，别拖垮整体预算 */
const CN_SOURCE_TIMEOUT_MS = 4_000
/** 百度跳转壳解析：单条最多这么久（实测正常 40ms，慢的时候也不会卡住整轮） */
const BAIDU_LINK_TIMEOUT_MS = 3_000
/** 百度跳转壳最多跟几跳重定向 */
const BAIDU_LINK_HOPS = 2
/** 一轮最多解析几个百度跳转壳：够填满来源面板就行（解析是并行的，多几条不慢） */
const MAX_BAIDU_LINKS = 12
/** 竞速阈值：哪个中文源先给出这么多条就直接用它 */
const ENOUGH_HITS = 3
/** 单页最多读这么多字节：兜底抓取可能碰到超大页面，只取前段 */
const MAX_BODY_BYTES = 1_000_000
/** 前端来源面板最多展示的条数 */
const MAX_HITS = 6
/** 单轮最多接受几个查询：本应用只传一个，这里防滥用 */
const MAX_QUERIES = 4
/** 摘要最多保留这么多字 */
const MAX_SNIPPET_CHARS = 300
/** 预热请求的时限：只为了把 TLS 握手做掉，不需要等正文 */
const WARMUP_TIMEOUT_MS = 5_000
/** 搜索站的桌面 UA：百度 / 360 对空 UA 或移动 UA 会直接给验证码页 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 折叠空白：搜索结果里的标题与摘要都是单行文本 */
const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim()

/** 块级标签：换成空格，避免两句粘成一句；行内标签（em/b/span）直接删掉，中文不该被拆开 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
])

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/gu

/** 去标签：注释直接删，块级标签换空格，行内标签删掉（`新华<em>科技</em>` → `新华科技`） */
const stripTags = (html: string): string =>
  html.replace(TAG_RE, (_all: string, _slash: string, name: string | undefined) => {
    if (name === undefined) {
      return ''
    }
    return BLOCK_TAGS.has(name.toLowerCase()) ? ' ' : ''
  })

/** 去掉 HTML 标签、注释、实体，再折叠空白：标题与摘要的统一清洗入口 */
const plainText = (raw: string): string => collapse(decodeEntities(stripTags(raw)))

/** 截断到 N 个字（前端来源面板与 system 注入都按字数算预算） */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max).trimEnd()

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
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
}

const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu

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

// ---------- 属性 / 标签小工具 ----------

/** 属性值：各家模板单双引号都可能出现 */
const attributeOf = (attrs: string, name: string): string => {
  const matched = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  if (!matched) {
    return ''
  }
  return matched[2] ?? matched[3] ?? ''
}

const classOf = (attrs: string): string => attributeOf(attrs, 'class')

const hasClass = (attrs: string, name: string): boolean =>
  classOf(attrs).split(/\s+/u).includes(name)

/** 取某个开标签的内容：截到同名的第一个闭标签为止（摘要里只会出现行内标签） */
const innerOf = (html: string, tagName: string, contentStart: number): string => {
  const close = new RegExp(`</${tagName}\\s*>`, 'i').exec(html.slice(contentStart))
  return close === null ? '' : html.slice(contentStart, contentStart + close.index)
}

/** 找出块里第一个「带某个类名的开标签」，返回标签名与内容起点 */
const findOpenTag = (
  html: string,
  pattern: RegExp
): { tagName: string; contentStart: number } | null => {
  const matched = pattern.exec(html)
  if (!matched) {
    return null
  }
  return { tagName: matched[1] ?? 'div', contentStart: matched.index + matched[0].length }
}

/**
 * 按「块开标签」切页：百度 / 360 都是 li、div 平铺的结果列表。
 * 传进来的正则必须带 g 标志且初始 lastIndex 为 0，否则 exec 会一直停在第一个匹配上。
 */
const splitBlocks = (html: string, blockRe: RegExp): string[] => {
  blockRe.lastIndex = 0
  const starts: number[] = []
  for (let matched = blockRe.exec(html); matched !== null; matched = blockRe.exec(html)) {
    // 防御：零宽匹配会让循环原地打转
    if (matched[0] === '') {
      blockRe.lastIndex += 1
      continue
    }
    starts.push(matched.index)
  }
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length))
}

// ---------- URL ----------

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

/** 相对地址按页面基准补全，再走绝对地址校验 */
const resolveUrl = (raw: string, base: string): string | null => {
  const text = decodeEntities(raw).trim()
  if (text === '') {
    return null
  }
  try {
    return absoluteHttpUrl(new URL(text, base).toString())
  } catch {
    return null
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 搜索站自己的页面不能当来源：跳转壳（baidu.com/link、so.com/link、bing.com/ck/a）、
 * 相关搜索、新闻聚合页点开都是搜索页，不如直接丢掉。
 * 例外：baijiahao.baidu.com 是真实文章页，保留。
 */
const isSearchEnginePage = (url: string): boolean => {
  const host = hostOf(url)
  if (host === '') {
    return true
  }
  if (host === 'so.com' || host.endsWith('.so.com')) {
    return true
  }
  if (host === 'bing.com' || host.endsWith('.bing.com')) {
    return true
  }
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
    return true
  }
  if (host === 'baidu.com' || (host.endsWith('.baidu.com') && !host.startsWith('baijiahao.'))) {
    return true
  }
  return false
}

// ---------- 时间 ----------

const EN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const monthName = (month: string): string => EN_MONTHS[Number.parseInt(month, 10) - 1] ?? ''

/**
 * 中文日期换成 Date.parse 认识的形式：
 *   百度「2026年11月2日」、Bing RSS「周一, 16 11月 2026 20:28:00 GMT」。
 * 认不出来就原样返回（pageAge 是自由文本，前端只做展示）。
 */
const toParsableDate = (text: string): string =>
  text
    .replace(/^(?:周|星期|礼拜)[一二三四五六日天]\s*[,，]?\s*/u, '')
    // Bing RSS：16 11月 2026 20:28:00 GMT
    .replace(
      /(\d{1,2})\s+(\d{1,2})\s*月\s+(\d{4})/u,
      (_all: string, day: string, month: string, year: string) =>
        `${day} ${monthName(month)} ${year}`
    )
    // 百度：2026年11月2日
    .replace(
      /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
      (_all: string, year: string, month: string, day: string) =>
        `${day} ${monthName(month)} ${year}`
    )

/** 日期串统一成 ISO；「5天前」这类相对时间解析不了，就保留原文（≤32 字） */
const toPageAge = (raw: string): string | null => {
  // 实体先解掉，否则「2026年11月2日&nbsp;-&nbsp;」后面那一串会把日期解析搞挂
  const text = collapse(decodeEntities(raw)).replace(/^[,，·\-–—\s]+|[,，·\-–—\s]+$/gu, '')
  if (text === '') {
    return null
  }
  const ms = Date.parse(toParsableDate(text))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : text.slice(0, 32)
}

/** 摘要开头的「5天前」「2026年11月2日 -」这类时间前缀：已经单独取到 pageAge，正文里去掉 */
const stripLeadingTime = (text: string): string =>
  text.replace(
    /^(?:\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{1,2}-\d{1,2})\s*[-–—·:：]?\s*/u,
    ''
  )

// ---------- 网络 ----------

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

/** 把「整体终止信号」和「本源自己的时限」合成一个信号；任一触发都算这一源失败 */
const gateOf = (signal: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('搜索超时')), ms)
  timer.unref()
  const forward = (): void => controller.abort(signal.reason)
  if (signal.aborted) {
    controller.abort(signal.reason)
  } else {
    signal.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
  }
}

/** 抓一页 HTML/XML：非 2xx 直接当失败（外层 attempt 会吞掉） */
const fetchDocument = async (
  endpoint: URL,
  signal: AbortSignal,
  accept: string,
  redirect: 'follow' | 'manual' = 'follow'
): Promise<string> => {
  const response = await fetch(endpoint, {
    method: 'GET',
    signal,
    redirect,
    headers: {
      accept,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': USER_AGENT,
    },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status}`)
  }
  return readBodyText(response, MAX_BODY_BYTES)
}

/** 单个搜索源失败不向外冒泡：调用方只关心「有没有结果」 */
const attempt = async (run: () => Promise<SearchHit[]>): Promise<SearchHit[]> => {
  try {
    return await run()
  } catch {
    return []
  }
}

/** 按 url 去重，保留先到的那条 */
const dedupeHits = (hits: SearchHit[]): SearchHit[] => {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of hits) {
    if (seen.has(hit.url) || isSearchEnginePage(hit.url)) {
      continue
    }
    seen.add(hit.url)
    out.push(hit)
  }
  return out
}

/** 统一收口：标题空就用 URL 兜底，摘要清干净并截断，日期空就 null */
const makeHit = (
  title: string,
  url: string,
  snippet: string,
  pageAge: string | null
): SearchHit => {
  const cleanTitle = plainText(title)
  const cleanSnippet = truncate(stripLeadingTime(plainText(snippet)), MAX_SNIPPET_CHARS)
  return {
    title: cleanTitle === '' ? url : cleanTitle,
    url,
    snippet: cleanSnippet,
    siteName: null,
    pageAge: pageAge === null || pageAge === '' ? null : pageAge,
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
  const endpoint = new URL(`${base.replace(/\/+$/u, '')}/search`)
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('format', 'json')
  endpoint.searchParams.set('language', 'zh-CN')

  const raw = await fetchDocument(endpoint, signal, 'application/json')
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
    if (!url || isSearchEnginePage(url)) {
      continue
    }
    const published = readString(item.publishedDate).trim()
    hits.push(
      makeHit(
        readString(item.title),
        url,
        readString(item.content),
        published === '' ? null : toPageAge(published)
      )
    )
    if (hits.length >= MAX_HITS) {
      break
    }
  }
  return hits
}

// ---------- 360（so.com） ----------

/** 结果块：`<li class="res-list ...">` */
const SO_BLOCK_RE = /<li\b[^>]*class="[^"]*\bres-list\b[^"]*"[^>]*>/giu
/** 标题：`<h3 class="res-title ..."><a href=...>标题</a></h3>`，类名可能带后缀 */
const SO_TITLE_RE = /<h3\b[^>]*class="[^"]*\bres-title\b[^"]*"[^>]*>/iu
/** 摘要：`<p class="res-desc">`；少数模板用 `<span data-result-summary>` */
const SO_DESC_RE =
  /<(p|div|span)\b[^>]*(?:class="[^"]*\bres-desc\b[^"]*"|data-result-summary)[^>]*>/iu
/** 日期前缀：`<span class="gray g-c-gray">2026年11月2日 - </span>` */
const SO_TIME_RE = /<span\b[^>]*class="[^"]*g-c-gray[^"]*"[^>]*>([\s\S]*?)<\/span\s*>/iu

/** 解析 360 结果页；链接是直链（跳转靠 data-mdurl 给出），所以不需要再解一次 */
const parseSo360 = (
  html: string
): { title: string; url: string; snippet: string; pageAge: string | null }[] => {
  const items: { title: string; url: string; snippet: string; pageAge: string | null }[] = []
  for (const block of splitBlocks(html, SO_BLOCK_RE)) {
    const titleOpen = SO_TITLE_RE.exec(block)
    if (!titleOpen) {
      continue
    }
    const titlePart = block.slice(titleOpen.index, titleOpen.index + 4_000)
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/iu.exec(titlePart)
    if (!anchor) {
      continue
    }
    const attrs = anchor[1] ?? ''
    // data-mdurl 是真实地址；href 多是 so.com/link 的跳转壳
    const mdUrl = resolveUrl(attributeOf(attrs, 'data-mdurl'), 'https://www.so.com')
    const hrefUrl = resolveUrl(attributeOf(attrs, 'href'), 'https://www.so.com')
    const url = mdUrl ?? (hrefUrl !== null && !isSearchEnginePage(hrefUrl) ? hrefUrl : null)
    if (!url || isSearchEnginePage(url)) {
      continue
    }
    const descOpen = findOpenTag(block, SO_DESC_RE)
    const snippet =
      descOpen === null ? '' : plainText(innerOf(block, descOpen.tagName, descOpen.contentStart))
    const timeMatched = SO_TIME_RE.exec(block)
    const pageAge = timeMatched ? toPageAge(timeMatched[1] ?? '') : null
    items.push({ title: plainText(anchor[2] ?? ''), url, snippet, pageAge })
    if (items.length >= MAX_HITS) {
      break
    }
  }
  return items
}

const searchSo360 = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const gate = gateOf(signal, CN_SOURCE_TIMEOUT_MS)
  try {
    const endpoint = new URL('https://www.so.com/s')
    endpoint.searchParams.set('q', query)
    const html = await fetchDocument(endpoint, gate.signal, 'text/html,application/xhtml+xml')
    return parseSo360(html)
      .map((item) => makeHit(item.title, item.url, item.snippet, item.pageAge))
      .filter((hit) => !isSearchEnginePage(hit.url))
  } finally {
    gate.dispose()
  }
}

// ---------- 百度 ----------

/** 结果块：`<div class="result ...">` / `<div class="result-op c-container ...">` */
const BAIDU_BLOCK_RE = /<div\b[^>]*class="[^"]*(?:c-container|\bresult\b)[^"]*"[^>]*>/giu
/** 标题：结果块里的 `<h3 ...><a href="http://www.baidu.com/link?url=...">标题</a></h3>` */
const BAIDU_TITLE_RE = /<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/iu
/** 摘要容器，按模板新旧依次尝试（类名都带哈希后缀，用包含匹配） */
const BAIDU_SNIPPET_CLASSES = ['content-right_', 'c-abstract', 'c-span-last', 'summary-text_']
/** 时间前缀：`<span class="... prefix-time_xxx">5天前</span>` */
const BAIDU_TIME_RE = /<span\b[^>]*class="[^"]*prefix-time[^"]*"[^>]*>([\s\S]*?)<\/span\s*>/iu
/** 兜底找绝对日期：老模板把日期直接写在摘要前面的灰色文字里 */
const BAIDU_DATE_RE = /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{1,2}-\d{1,2})/u
/** 验证码 / 安全校验页：命中就当这次检索失败 */
const BAIDU_CAPTCHA_RE = /wappass|safecheck|百度安全验证/iu
/** 百度一页最多收这么多候选（跳转壳解析失败的要丢掉，需要余量） */
const BAIDU_CANDIDATES = 12

/** 百度链接是跳转壳 `http://www.baidu.com/link?url=...`，必须解析成真实地址 */
const isBaiduShell = (raw: string): boolean => {
  try {
    const parsed = new URL(raw)
    return parsed.hostname === 'baidu.com' || parsed.hostname.endsWith('.baidu.com')
      ? parsed.pathname.startsWith('/link')
      : false
  } catch {
    return false
  }
}

/**
 * 百度自家页面（AI 卡片、榜单、相关搜索、推广 baidu.php）不是来源，直接跳过；
 * 跳转壳和百家号文章页要留着。
 */
const isBaiduInternal = (raw: string): boolean => {
  try {
    const parsed = new URL(raw)
    if (!(parsed.hostname === 'baidu.com' || parsed.hostname.endsWith('.baidu.com'))) {
      return false
    }
    if (parsed.hostname.startsWith('baijiahao.')) {
      return false
    }
    return !parsed.pathname.startsWith('/link')
  } catch {
    return true
  }
}

/**
 * 解析一条百度跳转壳：`GET` 后看 `location`，最多跟 2 跳。
 * 拿不到真实地址就返回 null，调用方会直接丢弃这条结果，
 * 绝不把百度跳转页塞进来源卡片。
 */
const resolveBaiduLink = async (shell: string, signal: AbortSignal): Promise<string | null> => {
  let current = shell
  for (let hop = 0; hop <= BAIDU_LINK_HOPS; hop += 1) {
    const gate = gateOf(signal, BAIDU_LINK_TIMEOUT_MS)
    try {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: gate.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9',
          'user-agent': USER_AGENT,
        },
      })
      const status = response.status
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (status >= 300 && status < 400 && location !== null) {
        const next = resolveUrl(location, current)
        if (next === null) {
          return null
        }
        current = next
        continue
      }
      if (status >= 200 && status < 300) {
        // 少数壳会直接 200 铺落地页，这时当前地址就是真实地址
        return isSearchEnginePage(current) ? null : absoluteHttpUrl(current)
      }
      return null
    } catch {
      return null
    } finally {
      gate.dispose()
    }
  }
  // 跟满 2 跳还是跳转：地址不可信，丢弃
  return null
}

/** 并行解析一批跳转壳；单条失败只是少一条结果 */
const resolveBaiduLinks = async (
  links: string[],
  signal: AbortSignal
): Promise<Map<string, string>> => {
  const shells = [...new Set(links.filter(isBaiduShell))].slice(0, MAX_BAIDU_LINKS)
  const resolved = new Map<string, string>()
  if (shells.length === 0) {
    return resolved
  }
  await Promise.all(
    shells.map(async (shell) => {
      const real = await resolveBaiduLink(shell, signal)
      if (real !== null) {
        resolved.set(shell, real)
      }
    })
  )
  return resolved
}

/** 解析百度结果页；返回的链接可能仍是跳转壳，由调用方统一解析 */
const parseBaidu = (
  html: string
): { title: string; link: string; snippet: string; pageAge: string | null }[] => {
  const items: { title: string; link: string; snippet: string; pageAge: string | null }[] = []
  for (const block of splitBlocks(html, BAIDU_BLOCK_RE)) {
    const titleMatched = BAIDU_TITLE_RE.exec(block)
    const scope = titleMatched?.[1] ?? block
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/iu.exec(scope)
    if (!anchor) {
      continue
    }
    const link = resolveUrl(attributeOf(anchor[1] ?? '', 'href'), 'https://www.baidu.com')
    if (link === null || isBaiduInternal(link)) {
      continue
    }
    const title = plainText(anchor[2] ?? '')
    if (title === '') {
      continue
    }

    let snippet = ''
    for (const name of BAIDU_SNIPPET_CLASSES) {
      const open = findOpenTag(
        block,
        new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*class="[^"]*${name}[^"]*"[^>]*>`, 'i')
      )
      if (open === null) {
        continue
      }
      const text = plainText(innerOf(block, open.tagName, open.contentStart))
      if (text !== '') {
        snippet = text
        break
      }
    }

    const timeMatched = BAIDU_TIME_RE.exec(block)
    const dateText = timeMatched?.[1] ?? BAIDU_DATE_RE.exec(block)?.[1] ?? ''
    items.push({ title, link, snippet, pageAge: toPageAge(dateText) })
    // 多收几条候选：跳转壳解析失败的会被丢掉，留点余量才不至于只剩两三张卡片
    if (items.length >= BAIDU_CANDIDATES) {
      break
    }
  }
  return items
}

const searchBaidu = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const gate = gateOf(signal, CN_SOURCE_TIMEOUT_MS)
  try {
    const endpoint = new URL('https://www.baidu.com/s')
    endpoint.searchParams.set('wd', query)
    endpoint.searchParams.set('rn', '10')
    const html = await fetchDocument(endpoint, gate.signal, 'text/html,application/xhtml+xml')
    if (BAIDU_CAPTCHA_RE.test(html)) {
      throw new Error('百度返回验证码页')
    }

    const items = parseBaidu(html)
    if (items.length === 0) {
      return []
    }
    // 跳转壳解析是并行的，最多 3 秒；解析失败的结果直接丢掉
    const resolved = await resolveBaiduLinks(
      items.map((item) => item.link),
      gate.signal
    )
    const hits: SearchHit[] = []
    for (const item of items) {
      const url = isBaiduShell(item.link) ? (resolved.get(item.link) ?? null) : item.link
      if (url === null || isSearchEnginePage(url)) {
        continue
      }
      hits.push(makeHit(item.title, url, item.snippet, item.pageAge))
    }
    return hits
  } finally {
    gate.dispose()
  }
}

// ---------- DuckDuckGo HTML 兜底 ----------

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

/**
 * 从结果页里取出 `result__a` 标题锚点与 `result__snippet` 摘要。
 * 摘要在不同版本的 DDG 模板里既可能是 <a> 也可能是 <div>，所以按「带 class 的开标签」找。
 */
const parseDuckDuckGo = (html: string): SearchHit[] => {
  const anchors: RawAnchor[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu
  for (let matched = anchorRe.exec(html); matched !== null; matched = anchorRe.exec(html)) {
    const attrs = matched[1] ?? ''
    if (!hasClass(attrs, 'result__a')) {
      continue
    }
    anchors.push({
      start: matched.index,
      href: attributeOf(attrs, 'href'),
      title: plainText(matched[2] ?? ''),
    })
  }

  const snippets: RawSnippet[] = []
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/giu
  for (let matched = openTagRe.exec(html); matched !== null; matched = openTagRe.exec(html)) {
    const tagName = matched[1] ?? ''
    const attrs = matched[2] ?? ''
    if (tagName === '' || !hasClass(attrs, 'result__snippet')) {
      continue
    }
    snippets.push({
      start: matched.index,
      text: plainText(innerOf(html, tagName, openTagRe.lastIndex)),
    })
  }

  const hits: SearchHit[] = []
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]
    if (!anchor) {
      continue
    }
    const url = realUrlOf(anchor.href)
    if (!url || isSearchEnginePage(url)) {
      continue
    }
    // 摘要属于「当前标题之后、下一个标题之前」的那一段
    const nextStart = anchors[index + 1]?.start ?? html.length
    const snippet = snippets.find((item) => item.start > anchor.start && item.start < nextStart)
    hits.push(makeHit(anchor.title, url, snippet?.text ?? '', null))
  }
  return hits
}

const searchDuckDuckGo = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const endpoint = new URL('https://html.duckduckgo.com/html/')
  endpoint.searchParams.set('q', query)
  return parseDuckDuckGo(await fetchDocument(endpoint, signal, 'text/html,application/xhtml+xml'))
}

// ---------- Bing ----------

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
      if (!target.startsWith('a1')) {
        return null
      }
      const padded = target.slice(2).replace(/-/gu, '+').replace(/_/gu, '/')
      try {
        const decoded = Buffer.from(padded, 'base64').toString('utf8')
        return decoded.startsWith('http') ? absoluteHttpUrl(decoded) : null
      } catch {
        return null
      }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return absoluteHttpUrl(parsed.toString())
  } catch {
    return null
  }
}

/** Bing HTML 结果块：`<li class="b_algo">` 里依次是 `<h2><a href>标题</a></h2>` 与 `<p>摘要</p>` */
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
    if (!url || isSearchEnginePage(url)) {
      continue
    }
    const snippetMatch = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/iu.exec(block)
    hits.push(makeHit(titleMatch[2] ?? '', url, snippetMatch?.[1] ?? '', null))
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
  return parseBing(await fetchDocument(endpoint, signal, 'text/html,application/xhtml+xml'))
}

/** 取 XML 里某个标签的原文（含 CDATA 的写法也要兼容） */
const xmlTagOf = (xml: string, name: string): string => {
  const matched = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(xml)
  return matched?.[1] ?? ''
}

/** RSS 文本字段：去 CDATA 包裹、去标签、解实体、折叠空白 */
const xmlTextOf = (xml: string, name: string): string =>
  plainText(xmlTagOf(xml, name).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1'))

/**
 * Bing RSS：`<item>` 里只有 title / link / description / pubDate，结构简单、500ms 内返回，
 * 是 HTML 版之前的首选兜底。
 */
const parseBingRss = (xml: string): SearchHit[] => {
  const hits: SearchHit[] = []
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/giu
  for (let matched = itemRe.exec(xml); matched !== null; matched = itemRe.exec(xml)) {
    const item = matched[1] ?? ''
    const url = realBingUrl(xmlTagOf(item, 'link').trim())
    if (!url || isSearchEnginePage(url)) {
      continue
    }
    hits.push(
      makeHit(
        xmlTextOf(item, 'title'),
        url,
        xmlTextOf(item, 'description'),
        toPageAge(xmlTextOf(item, 'pubDate'))
      )
    )
    if (hits.length >= MAX_HITS) {
      break
    }
  }
  return hits
}

const searchBingRss = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  const endpoint = new URL('https://www.bing.com/search')
  endpoint.searchParams.set('format', 'rss')
  endpoint.searchParams.set('q', query)
  const xml = await fetchDocument(
    endpoint,
    signal,
    'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'
  )
  return parseBingRss(xml)
}

// ---------- 调度 ----------

/** 竞速：谁先给出 ≥enough 条就用谁；全部不足则合并（保持先到先得的顺序） */
const firstEnough = (tasks: Promise<SearchHit[]>[], enough: number): Promise<SearchHit[]> =>
  new Promise((resolve) => {
    if (tasks.length === 0) {
      resolve([])
      return
    }
    let pending = tasks.length
    const collected: SearchHit[] = []
    let settled = false
    for (const task of tasks) {
      const onSettled = (hits: SearchHit[]): void => {
        if (settled) {
          return
        }
        if (hits.length >= enough) {
          settled = true
          resolve(dedupeHits(hits))
          return
        }
        collected.push(...hits)
        pending -= 1
        if (pending === 0) {
          settled = true
          resolve(dedupeHits(collected))
        }
      }
      // attempt 已经吞掉异常，这里的 reject 分支只是防御
      void task.then(onSettled, () => onSettled([]))
    }
  })

/** 360 与百度并行竞速；谁给够 3 条就用谁，都不够就合并两家 */
const searchChineseSources = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  if (signal.aborted) {
    return []
  }
  const race = new AbortController()
  const forward = (): void => race.abort(signal.reason)
  signal.addEventListener('abort', forward, { once: true })
  try {
    const hits = await firstEnough(
      [
        attempt(() => searchSo360(query, race.signal)),
        attempt(() => searchBaidu(query, race.signal)),
      ],
      ENOUGH_HITS
    )
    if (hits.length >= ENOUGH_HITS) {
      // 赢家已经够用，落败那一路不用再等它跑满 4 秒
      race.abort(new Error('竞速已结束'))
    }
    return hits
  } finally {
    signal.removeEventListener('abort', forward)
  }
}

/**
 * 单个查询的降级顺序：
 *   SearXNG → 360/百度竞速 → Bing RSS → Bing HTML → DDG
 * 每一档失败都只返回 []，绝不抛错。
 */
const searchOne = async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
  if (signal.aborted) {
    return []
  }

  // 1) 自建 SearXNG：配了就先试，有结果就用
  if (env.RAY_SEARXNG_URL) {
    const fromSearxng = dedupeHits(await attempt(() => searchSearxng(query, signal)))
    if (fromSearxng.length > 0) {
      return fromSearxng
    }
    if (signal.aborted) {
      return []
    }
  }

  // 2) 中文两家竞速：百度结果质量最好，360 最快，先到的够 3 条就直接交差
  const fromCn = await searchChineseSources(query, signal)
  if (fromCn.length > 0) {
    return fromCn
  }
  if (signal.aborted) {
    return []
  }

  // 3) Bing RSS：境内 200 / 半秒，结构比 HTML 稳定得多
  const fromRss = dedupeHits(await attempt(() => searchBingRss(query, signal)))
  if (fromRss.length > 0) {
    return fromRss
  }
  if (signal.aborted) {
    return []
  }

  // 4) Bing HTML：冷启动 8~10 秒，但只要连上了就有结果
  const fromBing = dedupeHits(await attempt(() => searchBing(query, signal)))
  if (fromBing.length > 0) {
    return fromBing
  }
  if (signal.aborted) {
    return []
  }

  // 5) DDG 保底：境内基本超时，留着只是为了让境外部署也还能用
  return dedupeHits(await attempt(() => searchDuckDuckGo(query, signal)))
}

/**
 * 预热：进程刚起来时到 bing.com 的首次 TLS 握手可能超过搜索预算（实测冷启动 ~8s），
 * 百度 / 360 也各要一次握手。先各发一个只建连、不读正文的请求，后续真实搜索就能落在一秒内。
 * 失败无所谓，纯粹是性能优化。
 */
export const warmupSearch = (): void => {
  const targets = ['https://www.baidu.com/', 'https://www.so.com/', 'https://www.bing.com/']
  for (const target of targets) {
    void fetch(target, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined)
  }
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
  // 提前一点点中止：给各源的 finally 收尾留出余量，保证对外答复仍在 8 秒内
  const timer = setTimeout(
    () => controller.abort(new Error('搜索超时')),
    Math.max(1_000, TIMEOUT_MS - ABORT_RESERVE_MS)
  )
  timer.unref()
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
