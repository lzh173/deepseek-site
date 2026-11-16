/**
 * 读链接兜底（GOAL.md §9 #5）：undici 抓取 + 本地正文提取。
 *
 * SSRF 是硬要求：协议、主机名、DNS 解析出的每个 IP 都要校验，
 * 重定向每一跳都重新校验；只允许 http/https，最多 3 跳。
 *
 * 失败统一抛 HttpError（400 / invalid_request）：
 *   - 被拦截：消息含 url_not_allowed（用 badRequest）
 *   - 抓取失败：消息含 url_not_accessible（前端据此把工具块标成读链接失败）
 */

import { lookup } from 'node:dns/promises'
import { fetch, type Response } from 'undici'
import { env } from '../env.ts'
import { badRequest, HttpError } from '../lib/errors.ts'

/** 一次读链接的总时限（含重定向） */
const TIMEOUT_MS = 15_000
/** 最多跟随几跳重定向；每跳都要重新做 SSRF 校验 */
const MAX_REDIRECTS = 3
/** 正文最多保留这么多字符（GOAL.md §9 #5 的上下文成本约束） */
const MAX_TEXT_CHARS = 12_000
/** 只认这些重定向状态码 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 读取结果：text 已是纯文本，可直接塞进 system */
export type ReadResult = {
  url: string
  title: string | null
  text: string
  publishedAt: string | null
}

// ---------- 错误 ----------

/** SSRF / 协议拦截：400 + url_not_allowed */
const notAllowed = (detail: string): HttpError =>
  badRequest(`读取链接失败：url_not_allowed（${detail}）`)

/** 抓取失败：400 + url_not_accessible */
const notAccessible = (detail: string): HttpError =>
  new HttpError(400, 'invalid_request', `读取链接失败：url_not_accessible（${detail}）`)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// ---------- SSRF 校验 ----------

/** 去掉 IPv6 的方括号与末尾的点，统一小写 */
const normalizeHost = (hostname: string): string =>
  hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.')
  if (parts.length !== 4) {
    return false
  }
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }
    const value = Number(part)
    if (value > 255) {
      return false
    }
    octets.push(value)
  }
  const first = octets[0]
  const second = octets[1]
  if (first === undefined || second === undefined) {
    return false
  }
  if (first === 0 || first === 10 || first === 127) {
    return true
  }
  // 169.254/16 链路本地（含云厂商元数据 169.254.169.254）
  if (first === 169 && second === 254) {
    return true
  }
  // 172.16/12
  if (first === 172 && second >= 16 && second <= 31) {
    return true
  }
  // 192.168/16
  if (first === 192 && second === 168) {
    return true
  }
  // 100.64/10 运营商级 NAT
  if (first === 100 && second >= 64 && second <= 127) {
    return true
  }
  return false
}

/** IPv4 映射到 IPv6 的两种写法：::ffff:127.0.0.1 与 ::ffff:7f00:1 */
const isPrivateMappedIpv4 = (tail: string): boolean => {
  if (tail.includes('.')) {
    return isPrivateIpv4(tail)
  }
  const bytes: number[] = []
  for (const part of tail.split(':')) {
    const value = Number.parseInt(part === '' ? '0' : part, 16)
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return false
    }
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return bytes.length === 4 && isPrivateIpv4(bytes.join('.'))
}

const isPrivateIpv6 = (address: string): boolean => {
  const value = address.toLowerCase()
  // ::（未指定）与 ::1（回环）
  if (value === '::' || value === '::1') {
    return true
  }
  const mapped = /^::ffff:(.+)$/.exec(value) ?? /^0:0:0:0:0:ffff:(.+)$/.exec(value)
  if (mapped?.[1]) {
    return isPrivateMappedIpv4(mapped[1])
  }
  const leading = Number.parseInt(value.split(':')[0] ?? '', 16)
  if (!Number.isInteger(leading)) {
    return false
  }
  // fc00::/7 唯一本地地址
  if ((leading & 0xfe00) === 0xfc00) {
    return true
  }
  // fe80::/10 链路本地
  if ((leading & 0xffc0) === 0xfe80) {
    return true
  }
  return false
}

/** 单个 IP 是否落在禁止访问的网段里 */
export const isPrivateAddress = (address: string): boolean =>
  address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address)

/**
 * 逐层校验目标：协议 → 主机名 → DNS 解析出的全部 IP。
 * 用 DNS 结果而不是只看字面主机名，才能挡住「域名解析到内网」的绕过。
 */
const assertAllowed = async (target: URL): Promise<void> => {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw notAllowed('只允许访问 http/https 链接')
  }
  const host = normalizeHost(target.hostname)
  if (host === '') {
    throw notAllowed('链接缺少主机名')
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw notAllowed('不允许访问本机地址')
  }
  if (isPrivateAddress(host)) {
    throw notAllowed('不允许访问内网地址')
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookup(host, { all: true })
  } catch (error) {
    throw notAccessible(`无法解析主机名 ${host}：${errorText(error)}`)
  }
  if (addresses.length === 0) {
    throw notAccessible(`无法解析主机名 ${host}`)
  }
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw notAllowed('该域名解析到内网地址')
  }
}

// ---------- 拉取 ----------

const parseTarget = (raw: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw notAllowed('链接格式不正确')
  }
  return parsed
}

/** 丢弃响应体，避免 keep-alive 连接悬挂 */
const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // 连接可能已经被对端关闭
  }
}

const request = async (target: URL, signal: AbortSignal): Promise<Response> => {
  try {
    return await fetch(target, {
      method: 'GET',
      // 手动处理重定向，才能每一跳都重新做 SSRF 校验
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': USER_AGENT,
      },
    })
  } catch (error) {
    throw notAccessible(errorText(error))
  }
}

/** 只读文本类内容；PDF / 图片等交给 M4 的解析链路，这里直接报不可访问 */
const isTextual = (contentType: string): boolean =>
  contentType === '' || /text\/|html|xml|json/i.test(contentType)

const charsetOf = (contentType: string): string => {
  const matched = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)
  return matched?.[1]?.toLowerCase() ?? ''
}

/** 从页面头部嗅探 charset（很多中文站点只在 <meta> 里声明 gbk） */
const sniffCharset = (bytes: Buffer): string => {
  const head = bytes.subarray(0, 2048).toString('latin1')
  const meta = /<meta\b[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)
  return meta?.[1]?.toLowerCase() ?? ''
}

const decodeBytes = (bytes: Buffer, charset: string): string => {
  const label = charset !== '' ? charset : sniffCharset(bytes)
  if (label !== '') {
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // 不认识的编码标签，退回 utf-8
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** 正文上限由 env.RAY_READ_MAX_BYTES 控制，超出部分直接截断 */
const readBodyText = async (
  response: Response,
  maxBytes: number,
  charset: string
): Promise<string> => {
  const body = response.body
  if (!body) {
    return ''
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (total < maxBytes) {
        chunks.push(value)
      }
      total += value.byteLength
      if (total >= maxBytes) {
        break
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 连接可能已经被对端关闭
    }
  }
  return decodeBytes(Buffer.concat(chunks, Math.min(total, maxBytes)), charset)
}

// ---------- 正文提取 ----------

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, ' ')

const collapseText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const entityRe = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g
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

/** 简单实体解码；非法码点原样保留 */
const decodeEntities = (text: string): string =>
  text.replace(entityRe, (whole: string, body: string) => {
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

/** 取属性值；单双引号都支持 */
const attributeOf = (tag: string, name: string): string | null => {
  const matched = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  if (!matched) {
    return null
  }
  return matched[2] ?? matched[3] ?? ''
}

const titleOf = (html: string): string | null => {
  const matched = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  if (!matched) {
    return null
  }
  const title = collapseText(decodeEntities(stripTags(matched[1] ?? '')))
  return title === '' ? null : title
}

/** 发布时间：常见 meta 声明优先，其次 <time datetime>；取不到就是 null */
const publishedAtOf = (html: string): string | null => {
  const keys = new Set([
    'article:published_time',
    'og:published_time',
    'datepublished',
    'publish_date',
    'pubdate',
    'date',
  ])
  const tagRe = /<meta\b[^>]*>/gi
  for (let matched = tagRe.exec(html); matched !== null; matched = tagRe.exec(html)) {
    const tag = matched[0]
    const key = (
      attributeOf(tag, 'property') ??
      attributeOf(tag, 'name') ??
      attributeOf(tag, 'itemprop') ??
      ''
    ).toLowerCase()
    if (!keys.has(key)) {
      continue
    }
    const value = attributeOf(tag, 'content')
    if (value !== null && value.trim() !== '') {
      return decodeEntities(value).trim()
    }
  }
  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)
  return time?.[1] ? decodeEntities(time[1]).trim() : null
}

/** HTML → 纯文本：去脚本样式、块级标签换行、折叠空白、截断 */
const htmlToText = (html: string): string => {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    // title 已单独取出，正文里不要再重复一遍
    .replace(/<title\b[\s\S]*?<\/title\s*>/gi, ' ')
    // head 里的其余内容（meta / link）不该混进正文
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|dd|dt)\s*>/gi,
      '\n'
    )
    .replace(/<[^>]*>/g, ' ')
  return collapseText(decodeEntities(stripped)).slice(0, MAX_TEXT_CHARS)
}

type Extracted = { title: string | null; text: string; publishedAt: string | null }

const extract = (html: string): Extracted => ({
  title: titleOf(html),
  text: htmlToText(html),
  publishedAt: publishedAtOf(html),
})

// ---------- 对外入口 ----------

/**
 * 读取一个链接的正文。
 * 成功返回纯文本；失败抛 HttpError（消息里带 url_not_allowed / url_not_accessible）。
 */
export const readUrl = async (url: string, signal?: AbortSignal): Promise<ReadResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('读取超时')), TIMEOUT_MS)
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  try {
    let target = parseTarget(url)
    await assertAllowed(target)

    for (let hop = 0; ; hop += 1) {
      const response = await request(target, controller.signal)

      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location')
        await discard(response)
        if (location === null || location.trim() === '') {
          throw notAccessible('重定向缺少 Location')
        }
        if (hop >= MAX_REDIRECTS) {
          throw notAccessible('重定向次数过多')
        }
        target = parseTarget(new URL(location, target).toString())
        // 每一跳都重新校验，防止公网地址 302 到内网
        await assertAllowed(target)
        continue
      }

      if (!response.ok) {
        await discard(response)
        throw notAccessible(`目标站点返回 ${response.status}`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!isTextual(contentType)) {
        await discard(response)
        throw notAccessible(`不支持的内容类型：${contentType.split(';')[0] ?? contentType}`)
      }

      const html = await readBodyText(response, env.RAY_READ_MAX_BYTES, charsetOf(contentType))
      const extracted = extract(html)
      if (extracted.text === '') {
        throw notAccessible('页面没有可提取的正文')
      }
      return {
        url: target.toString(),
        title: extracted.title,
        text: extracted.text,
        publishedAt: extracted.publishedAt,
      }
    }
  } catch (error) {
    throw error instanceof HttpError ? error : notAccessible(errorText(error))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
