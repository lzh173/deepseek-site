import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Db } from '../db/index.ts'
import type { FileRow } from '../db/types.ts'
import { env } from '../env.ts'
import { nowIso } from '../lib/time.ts'

/**
 * 附件存储：sha256 内容寻址（同内容只落一份）+ files.ref_count 引用计数。
 *
 * ## 归属取舍（重要）
 * `files` 表没有 owner 列（0001_init.sql 不可改），归属只能反查
 * `session_files` → `sessions.user_id`。因此规则是：
 *
 *   · 已被某个会话引用 → **只有该会话的属主**可读、可删；
 *   · 尚未被任何会话引用 → **任何已登录用户都可读、可删**。
 *
 * 第二种情况是为了兼容前端"选中即上传"：文件先落库、随后才随 `PUT /sessions/:id`
 * 写进 `session_files` 建立归属，这段窗口里服务端拿不到"是谁传的"。窗口很短，
 * 且 sha256 是不可枚举的 64 位十六进制串，实际被他人猜中并读取的风险可忽略；
 * 一旦写进会话，归属立即收紧到会话属主。等 schema 允许加 owner 列时应当改掉。
 *
 * ## 目录布局
 * `<RAY_DATA_DIR>/files/<sha256 前两位>/<sha256>`，上传时先写 `<RAY_DATA_DIR>/files/.tmp-<random>`
 * 再 rename 到目标路径，避免半截文件被当成有效内容。
 */

/** 全库存储上限 20 GB（GOAL.md §11.1）。files 按 sha256 去重，这里用去重后的全库占用估算。 */
export const MAX_STORAGE_BYTES = 20 * 1024 * 1024 * 1024

/** 配额报错文案里的上限；前端正则 `User storage quota exceeded.*?limit ([\d.]+) GB`。 */
export const STORAGE_LIMIT_LABEL = '20 GB'

const SHA256_RE = /^[0-9a-f]{64}$/

/** 前端传回的 file id 就是 sha256；格式不对直接当作"文件不存在"。 */
export const isSha256 = (value: string): boolean => SHA256_RE.test(value)

/** 附件根目录：<RAY_DATA_DIR>/files */
export const filesRoot = (): string => path.join(env.dataDir, 'files')

/** 内容寻址落盘路径：files/<前两位>/<sha256> */
export const fileDiskPath = (sha256: string): string =>
  path.join(filesRoot(), sha256.slice(0, 2), sha256)

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.promises.access(target)
    return true
  } catch {
    return false
  }
}

/** 删除磁盘文件；文件本来就不在视为成功。 */
export const unlinkQuietly = async (filePath: string): Promise<void> => {
  try {
    await fs.promises.unlink(filePath)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      throw error
    }
  }
}

export type StoredUpload = {
  sha256: string
  size: number
  /** true 表示同内容已存在，磁盘上没有产生新文件 */
  existed: boolean
}

/**
 * 边读边算 sha256 并落盘：`Readable → 边算边透传 → 临时文件`，算完再 rename。
 * 全程流式，不会把整个文件读进内存；目标路径已存在时删掉临时文件即可（内容相同）。
 *
 * 注意：`createHash()` 在流里是"只吞不出"的 sink（结束时才吐出摘要），
 * 不能直接放进 pipeline 中间，必须自己包一层 Transform 边 update 边透传。
 */
export const storeUpload = async (stream: Readable): Promise<StoredUpload> => {
  const root = filesRoot()
  await fs.promises.mkdir(root, { recursive: true })
  const tmpPath = path.join(root, `.tmp-${randomBytes(8).toString('hex')}`)
  const hash = createHash('sha256')
  let size = 0
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      size += chunk.length
      done(null, chunk)
    },
  })
  try {
    await pipeline(stream, tap, fs.createWriteStream(tmpPath))
    const sha256 = hash.digest('hex')
    const target = fileDiskPath(sha256)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    if (await pathExists(target)) {
      await fs.promises.unlink(tmpPath)
      return { sha256, size, existed: true }
    }
    try {
      await fs.promises.rename(tmpPath, target)
    } catch (error) {
      // 并发上传同一内容时，另一个请求可能刚把目标 rename 到位；此时丢掉自己的临时文件即可。
      await fs.promises.unlink(tmpPath).catch(() => undefined)
      if (await pathExists(target)) {
        return { sha256, size, existed: true }
      }
      throw error
    }
    return { sha256, size, existed: false }
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

export type RegisterFileInput = {
  sha256: string
  size: number
  mime: string
  name: string
}

/**
 * 登记一次上传。
 *
 * 注意：**上传本身不占引用计数**。引用只由「会话引用该附件」建立（见 sessions.ts 的
 * syncSessionFiles），这样删会话时计数能真正归零并立刻释放文件；
 * 上传后从没被引用过的文件 `ref_count = 0`，交给 24 小时孤儿清理任务回收。
 * 内容相同只存一份，文件名与 MIME 保留首次登记的值。
 */
export const registerFile = (db: Db, input: RegisterFileInput): FileRow => {
  const existing = db
    .prepare('SELECT * FROM files WHERE sha256 = ?')
    .get(input.sha256) as FileRow | undefined

  if (existing) {
    return existing
  }

  const row: FileRow = {
    sha256: input.sha256,
    size: input.size,
    mime: input.mime,
    name: input.name,
    ref_count: 0,
    created_at: nowIso(),
  }
  db.prepare(
    'INSERT INTO files (sha256, size, mime, name, ref_count, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.sha256, row.size, row.mime, row.name, row.ref_count, row.created_at)
  return row
}

export const findFile = (db: Db, sha256: string): FileRow | null =>
  (db.prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256) as FileRow | undefined) ?? null

/** 去重后的全库占用字节数；配额判定用。 */
export const storageUsedBytes = (db: Db): number => {
  const row = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files').get() as {
    total: number
  }
  return row.total
}

/** 引用该文件的会话属主集合。空集合代表"尚未被任何会话引用"。 */
export const findFileOwners = (db: Db, sha256: string): string[] =>
  (
    db
      .prepare(
        `SELECT DISTINCT s.user_id AS user_id
         FROM session_files sf
         JOIN sessions s ON s.id = sf.session_id
         WHERE sf.sha256 = ?`
      )
      .all(sha256) as { user_id: string }[]
  ).map((row) => row.user_id)

/** 归属判定：被会话引用时只认属主；无人引用时对任何已登录用户开放（见文件头注释）。 */
export const canAccessFile = (db: Db, userId: string, sha256: string): boolean => {
  const owners = findFileOwners(db, sha256)
  return owners.length === 0 || owners.includes(userId)
}

/** 引用计数 +1；文件不存在返回 false。 */
export const incrementFileRef = (db: Db, sha256: string): boolean =>
  db.prepare('UPDATE files SET ref_count = ref_count + 1 WHERE sha256 = ?').run(sha256).changes > 0

/** 引用计数 -1（不会减到负数）；返回新的计数，文件不存在返回 -1。 */
export const decrementFileRef = (db: Db, sha256: string): number => {
  const row = db.prepare('SELECT ref_count FROM files WHERE sha256 = ?').get(sha256) as
    | { ref_count: number }
    | undefined
  if (!row) {
    return -1
  }
  const next = Math.max(row.ref_count - 1, 0)
  db.prepare('UPDATE files SET ref_count = ? WHERE sha256 = ?').run(next, sha256)
  return next
}

/** 删除 files 记录（会级联删掉 session_files 引用行）；返回是否真的删掉了。 */
export const deleteFileRow = (db: Db, sha256: string): boolean =>
  db.prepare('DELETE FROM files WHERE sha256 = ?').run(sha256).changes > 0

/**
 * 事务内减引用；归零时删记录，并返回需要从磁盘删掉的路径。
 * 磁盘操作放在事务外由调用方执行，避免失败回滚时出现"记录还在、文件没了"。
 */
export const releaseFile = (db: Db, sha256: string): string | null =>
  db.transaction((): string | null => {
    if (decrementFileRef(db, sha256) !== 0) {
      return null
    }
    return deleteFileRow(db, sha256) ? fileDiskPath(sha256) : null
  })()

/** 浏览器给不出类型的通用 MIME（Windows 上很常见），需要按扩展名补齐。 */
const GENERIC_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'unknown/unknown',
  'application/x-unknown',
])

/** 明确拒绝的可执行文件类型；其余 `application/x-*` 放行。 */
const REJECTED_MIMES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sharedlib',
  'application/x-elf',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
])

/** 可直接采用的 MIME 类别：图片、文本/代码、音视频、字体、办公文档与结构化数据。 */
const ACCEPTED_MIME_PREFIXES = [
  'image/',
  'text/',
  'audio/',
  'video/',
  'font/',
  'application/vnd.',
  'application/x-',
]

const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/zip',
  'application/gzip',
  'application/rtf',
  'application/msword',
  'application/epub+zip',
  'application/xhtml+xml',
  'application/yaml',
  'application/toml',
  'application/sql',
])

/** 扩展名 → MIME；前端已按扩展名白名单过滤，这里只负责补出可用的 MIME。 */
const MIME_BY_EXT: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  pjpeg: 'image/jpeg',
  pjp: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  avifs: 'image/avif',
  apng: 'image/apng',
  xbm: 'image/x-xbitmap',
  psd: 'image/vnd.adobe.photoshop',
  // 文档
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  rtf: 'application/rtf',
  // 文本 / 代码
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xht: 'text/html',
  xhtml: 'application/xhtml+xml',
  xml: 'application/xml',
  xsl: 'application/xml',
  xslt: 'application/xml',
  xsd: 'application/xml',
  json: 'application/json',
  json5: 'application/json',
  jsonld: 'application/ld+json',
  geojson: 'application/geo+json',
  ipynb: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  properties: 'text/plain',
  env: 'text/plain',
  gitignore: 'text/plain',
  gitkeep: 'text/plain',
  gitmodules: 'text/plain',
  editorconfig: 'text/plain',
  lock: 'text/plain',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  styl: 'text/x-stylus',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  mts: 'text/typescript',
  cts: 'text/typescript',
  tsx: 'text/tsx',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  py: 'text/x-python',
  py3: 'text/x-python',
  pyi: 'text/x-python',
  pyw: 'text/x-python',
  pyde: 'text/x-python',
  c: 'text/x-c',
  h: 'text/x-c',
  cc: 'text/x-c',
  cpp: 'text/x-c++',
  cxx: 'text/x-c++',
  cppobjdump: 'text/x-c++',
  hpp: 'text/x-c++',
  hxx: 'text/x-c++',
  hh: 'text/x-c++',
  inl: 'text/x-c++',
  cs: 'text/x-csharp',
  csx: 'text/x-csharp',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  go: 'text/x-go',
  rs: 'text/x-rust',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  php3: 'text/x-php',
  php4: 'text/x-php',
  php5: 'text/x-php',
  php7: 'text/x-php',
  php8: 'text/x-php',
  phtml: 'text/x-php',
  asp: 'text/asp',
  aspx: 'text/asp',
  jsp: 'text/plain',
  sql: 'application/sql',
  sh: 'text/x-sh',
  bash: 'text/x-sh',
  zsh: 'text/x-sh',
  fish: 'text/x-sh',
  ksh: 'text/x-sh',
  bat: 'text/x-bat',
  cmd: 'text/x-bat',
  ps1: 'text/x-powershell',
  psd1: 'text/x-powershell',
  psm1: 'text/x-powershell',
  lua: 'text/x-lua',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  r: 'text/x-r',
  swift: 'text/x-swift',
  scala: 'text/x-scala',
  dart: 'text/x-dart',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  erl: 'text/x-erlang',
  hrl: 'text/x-erlang',
  hs: 'text/x-haskell',
  clj: 'text/x-clojure',
  cljs: 'text/x-clojure',
  cljc: 'text/x-clojure',
  edn: 'text/x-clojure',
  ml: 'text/x-ocaml',
  mli: 'text/x-ocaml',
  fs: 'text/x-fsharp',
  fsx: 'text/x-fsharp',
  groovy: 'text/x-groovy',
  gradle: 'text/x-groovy',
  tex: 'text/x-tex',
  // 微信 / 支付宝小程序模板：按纯文本处理
  wxml: 'text/plain',
  wxss: 'text/plain',
  wxs: 'text/plain',
  axml: 'text/plain',
  acss: 'text/plain',
  sjs: 'text/plain',
  swan: 'text/plain',
  ttml: 'text/plain',
  ttss: 'text/plain',
  qml: 'text/plain',
  qss: 'text/plain',
}

/** 取扩展名（小写，不含点）；没有扩展名时返回空串。 */
const extOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

/**
 * 识别上传文件的 MIME；返回 null 表示"无法识别"（路由层据此返回 400）。
 * 客户端声明的类型可用就直接用，只有通用类型（Windows 常见）才退回扩展名推断。
 */
export const resolveUploadMime = (filename: string, declared: string): string | null => {
  const mime = (declared.split(';')[0] ?? '').trim().toLowerCase()
  if (!GENERIC_MIMES.has(mime)) {
    if (REJECTED_MIMES.has(mime)) {
      return null
    }
    if (ACCEPTED_MIMES.has(mime) || ACCEPTED_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
      return mime
    }
  }
  return MIME_BY_EXT[extOf(filename)] ?? null
}

/**
 * 头部是否像文本：出现 NUL 字节或控制字符比例过高就按二进制处理。
 * 用于扩展名陌生的文件（如 `.wxml`）退回 `text/plain`，而不是直接拒绝。
 */
export const looksLikeText = (head: Buffer): boolean => {
  if (head.length === 0) {
    return true
  }
  let suspicious = 0
  for (const byte of head) {
    if (byte === 0) {
      return false
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      suspicious += 1
    }
  }
  return suspicious / head.length < 0.02
}

/**
 * 边流边留前若干字节，用于在流结束后判断未知类型的文件是不是文本。
 * 返回的 stream 必须交给 pipeline 消费，否则不会继续读取源流。
 */
export const sampleHead = (
  stream: Readable,
  limit = 4096
): { stream: Readable; head: () => Buffer } => {
  let head = Buffer.alloc(0)
  const sampler = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (head.length < limit) {
        head = Buffer.concat([head, chunk.subarray(0, limit - head.length)])
      }
      done(null, chunk)
    },
  })
  return { stream: stream.pipe(sampler), head: () => head }
}
