/**
 * 文档解析兜底（GOAL.md §9 #6）：把附件在服务端抽成纯文本，让模型真的能读到内容。
 *
 * 能力边界（纯 JS、不依赖外部服务；不还原版面，见 §9 的降级表现）：
 *   · pdf  → unpdf（PDF.js）的文本层。扫描件没有文本层，抽不出内容，返回 null
 *   · docx → mammoth 的原始文本
 *   · pptx → jszip 解包，按 slide 编号顺序抽 `<a:t>` 文本
 *   · xlsx → jszip 解包，取 sharedStrings.xml 的 `<t>`；没有共享串表时退回表格内的 inlineStr
 *   · 文本类（text/*、json/yaml/xml…）→ utf-8 直接解码
 *   · 图片、音视频、压缩包等二进制 → null，由调用方按模型能力给出占位文本（§9 铁律 1）
 *
 * 两条铁律落在这里：
 *   1. 失败绝不外抛 —— 返回 null 并 console.warn 一行（带文件名），
 *      否则一个坏文件就能打断整轮对话（§9 铁律 3）；
 *   2. 单文档最多保留 20000 字符，超出截断并加标记 —— 一份长文档不许吃掉整个上下文。
 */

import JSZip from 'jszip'
import mammoth from 'mammoth'

/** 抽取结果：text 已规范化空白并按单文档上限截断。 */
export type Extracted = {
  text: string
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text'
  /** pdf 的总页数 / pptx 的幻灯片数；其余格式没有页的概念 */
  pages?: number
}

/** 单文档正文上限：长文档不能把整轮上下文挤爆 */
const MAX_CHARS = 20_000

/** 截断标记：让模型和用户都知道正文不完整（§9 铁律 1「兜底必须显式」） */
const TRUNCATED_MARK = '\n…（已截断）'

const PDF_MIME = 'application/pdf'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** 纯文本类 MIME：text/* 之外还认这些结构化文本 */
const TEXT_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/yaml',
  'application/toml',
  'application/sql',
])

/** 纯文本扩展名；MIME 不可信（浏览器/中转站常给 octet-stream）时用它兜底 */
const TEXT_EXTS = new Set([
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'json5',
  'jsonld',
  'geojson',
  'xml',
  'xsl',
  'xslt',
  'xsd',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'vue',
  'svelte',
  'py',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'java',
  'kt',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'ps1',
  'lua',
  'pl',
  'r',
  'swift',
  'scala',
  'dart',
  'sql',
  'tex',
  'ipynb',
])

/** 扩展名 → 文档类型；与 MIME 同时使用，任一命中即可 */
const KIND_BY_EXT: Record<string, Extracted['kind']> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  pptx: 'pptx',
  pptm: 'pptx',
  ppsx: 'pptx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 裸 MIME：去掉 charset 等参数，统一小写 */
const baseMime = (mime: string): string => (mime.split(';')[0] ?? '').trim().toLowerCase()

/** 取扩展名（小写、不含点）；没有扩展名返回空串 */
const extOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

/** 判定文档类型；null 表示不支持的二进制，调用方据此给占位文本 */
const kindOf = (mime: string, filename: string): Extracted['kind'] | null => {
  const byExt = KIND_BY_EXT[extOf(filename)]
  if (mime === PDF_MIME || byExt === 'pdf') {
    return 'pdf'
  }
  if (mime === DOCX_MIME || byExt === 'docx') {
    return 'docx'
  }
  if (mime === PPTX_MIME || byExt === 'pptx') {
    return 'pptx'
  }
  if (mime === XLSX_MIME || byExt === 'xlsx') {
    return 'xlsx'
  }
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime) || TEXT_EXTS.has(extOf(filename))) {
    return 'text'
  }
  return null
}

// ---------- 空白规范化与截断 ----------

/**
 * 统一空白：
 * - CRLF/CR → LF，丢掉会让上游 JSON 编码出问题的控制字符；
 * - NBSP / 全角空格 → 普通空格；
 * - 清行尾空白、连续 3 行以上的空行压成 1 行。
 *
 * 刻意**不**合并行首缩进与行内多空格：代码、表格对齐对模型是有信息量的，
 * 抹平之后反而更难读。
 */
const normalizeWhitespace = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** 单文档截断：超出上限时在末尾补标记，长度只多出标记本身 */
const limitText = (text: string): string =>
  text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}${TRUNCATED_MARK}` : text

// ---------- xml 辅助（pptx / xlsx 共用） ----------

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** 解 XML 实体；不认识的实体原样保留，避免把正文改坏 */
const decodeXml = (text: string): string =>
  text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole: string, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body.startsWith('#x') || body.startsWith('#X')
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10)
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole
      }
      return XML_ENTITIES[body] ?? XML_ENTITIES[body.toLowerCase()] ?? whole
    }
  )

/** 取某个标签的全部文本（含富文本 run，内含多个同类标签时会逐个产出） */
const tagTexts = (xml: string, tag: string): string[] => {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const texts: string[] = []
  for (const matched of xml.matchAll(pattern)) {
    texts.push(decodeXml(matched[1] ?? ''))
  }
  return texts
}

/** `ppt/slides/slide12.xml` → 12；不是幻灯片返回 0 */
const slideNumberOf = (name: string): number => {
  const matched = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)
  return matched?.[1] === undefined ? 0 : Number(matched[1])
}

/** `xl/worksheets/sheet12.xml` → 12；不是工作表返回 0 */
const sheetNumberOf = (name: string): number => {
  const matched = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)
  return matched?.[1] === undefined ? 0 : Number(matched[1])
}

// ---------- 各格式提取 ----------

/** PDF：只取文本层（扫描件抽不出内容，M3 不接 OCR） */
const extractPdf = async (bytes: Uint8Array): Promise<Extracted> => {
  // 懒加载：PDF.js 体积大，只有真的遇到 PDF 时才付这份启动代价
  const { extractText } = await import('unpdf')
  const result = await extractText(bytes, { mergePages: true })
  return { text: result.text, kind: 'pdf', pages: result.totalPages }
}

/** docx：mammoth 的原始文本，不保留样式与表格结构 */
const extractDocx = async (bytes: Uint8Array): Promise<Extracted> => {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return { text: result.value, kind: 'docx' }
}

/** pptx：按 slide 编号升序抽 `<a:t>`，幻灯片之间空一行 */
const extractPptx = async (bytes: Uint8Array): Promise<Extracted> => {
  const zip = await JSZip.loadAsync(bytes)
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, number: slideNumberOf(name) }))
    .filter((slide) => slide.number > 0)
    .sort((a, b) => a.number - b.number)

  const parts: string[] = []
  for (const slide of slides) {
    const file = zip.files[slide.name]
    if (!file) {
      continue
    }
    parts.push(tagTexts(await file.async('string'), 'a:t').join('\n'))
  }
  return { text: parts.join('\n\n'), kind: 'pptx', pages: slides.length }
}

/**
 * xlsx：优先读共享字符串表；没有（或全空）时退回工作表里的 inlineStr。
 * 「够用即可」：不还原单元格坐标、公式与样式，只把文本按出现顺序排出来。
 */
const extractXlsx = async (bytes: Uint8Array): Promise<Extracted> => {
  const zip = await JSZip.loadAsync(bytes)
  const shared = zip.file('xl/sharedStrings.xml')
  if (shared) {
    const texts = tagTexts(await shared.async('string'), 't')
    if (texts.length > 0) {
      return { text: texts.join('\n'), kind: 'xlsx' }
    }
  }

  const sheets = Object.keys(zip.files)
    .map((name) => ({ name, number: sheetNumberOf(name) }))
    .filter((sheet) => sheet.number > 0)
    .sort((a, b) => a.number - b.number)

  const texts: string[] = []
  for (const sheet of sheets) {
    const file = zip.files[sheet.name]
    if (!file) {
      continue
    }
    texts.push(...tagTexts(await file.async('string'), 't'))
  }
  return { text: texts.join('\n'), kind: 'xlsx' }
}

/** 纯文本：直接 utf-8 解码（BOM 由 TextDecoder 自行剥掉） */
const extractPlainText = (bytes: Uint8Array): Extracted => ({
  text: new TextDecoder('utf-8').decode(bytes),
  kind: 'text',
})

const extractByKind = async (kind: Extracted['kind'], bytes: Uint8Array): Promise<Extracted> => {
  if (kind === 'pdf') {
    return await extractPdf(bytes)
  }
  if (kind === 'docx') {
    return await extractDocx(bytes)
  }
  if (kind === 'pptx') {
    return await extractPptx(bytes)
  }
  if (kind === 'xlsx') {
    return await extractXlsx(bytes)
  }
  return extractPlainText(bytes)
}

/** 头部出现 NUL 字节：多半是伪装成文本的二进制，解出来只会是乱码 */
const looksBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 4096).includes(0)

// ---------- 对外入口 ----------

/**
 * 从附件字节里抽正文。
 * 成功返回 `Extracted`；不支持的格式、空内容、解析失败一律返回 null（不抛异常）。
 *
 * 调用方负责：文件存在性 / 归属校验、按模型能力决定内联还是占位、
 * 以及多个文档之间的总字符预算（这里是「单文档」上限）。
 */
export const extractDocument = async (
  bytes: Uint8Array,
  mime: string,
  filename: string
): Promise<Extracted | null> => {
  if (bytes.byteLength === 0) {
    return null
  }
  const kind = kindOf(baseMime(mime), filename)
  if (kind === null) {
    return null
  }
  if (kind === 'text' && looksBinary(bytes)) {
    // 声明成文本但内容是二进制：按无法解析处理，别给模型喂乱码
    return null
  }

  try {
    const extracted = await extractByKind(kind, bytes)
    const text = limitText(normalizeWhitespace(extracted.text))
    if (text === '') {
      // 扫描版 PDF、纯图片 pptx：没有文本层可抽，交给调用方降级（§10 的多模态链路）
      console.warn(`[documents] ${filename} 没有可提取的文本（${kind}）`)
      return null
    }
    return { ...extracted, text }
  } catch (error) {
    // 坏文件、加密 PDF、截断的 docx……统一降级，绝不把异常抛进对话链路
    console.warn(`[documents] 解析 ${filename} 失败：${errorText(error)}`)
    return null
  }
}
