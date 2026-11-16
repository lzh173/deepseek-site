import fs from 'node:fs'
import type { MultipartFile } from '@fastify/multipart'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Db } from '../db/index.ts'
import { env } from '../env.ts'
import { badRequest, tooLarge } from '../lib/errors.ts'
import { requireUser } from '../plugins/auth.ts'
import {
  MAX_STORAGE_BYTES,
  STORAGE_LIMIT_LABEL,
  canAccessFile,
  fileDiskPath,
  findFile,
  isSha256,
  looksLikeText,
  registerFile,
  releaseFile,
  resolveUploadMime,
  sampleHead,
  storageUsedBytes,
  storeUpload,
  unlinkQuietly,
  type StoredUpload,
} from '../storage/files.ts'

/**
 * /api/files：附件上传 / 下载 / 删除，sha256 内容寻址（GOAL.md §6.1 / §11）。
 *
 * 三个必须被前端正则命中的 400 文案（GOAL.md §6.4）：
 *   · 存储配额  → `User storage quota exceeded, limit 20 GB`
 *   · 文件不存在 → `file_ids do not exist or are not created under your account`
 *   · 无法识别  → `Failed to recognize the file`
 * 单文件过大走 413，前端按状态码归类，文案不限。
 *
 * 上传全程流式：`part.file → sha256 → 临时文件 → rename`，不会把整个文件读进内存。
 * 权限与归属取舍见 `storage/files.ts` 头部注释。
 */

/** 与前端 `FileObject` 一致的响应体（src/services/api/types.ts）。 */
type FileObject = {
  id: string
  type: 'file'
  size_bytes: number
  created_at: string
  filename: string
  mime_type: string
}

/** 文本 / 代码 / 表格（purpose=user_data）单文件上限，GOAL.md §11.1。 */
const USER_DATA_MAX_MB = 32

/** 图片单文件上限，GOAL.md §11.1。 */
const IMAGE_MAX_MB = 20

const MB = 1024 * 1024

const statusOf = (error: unknown): number | undefined => {
  const code = (error as { statusCode?: unknown }).statusCode
  return typeof code === 'number' ? code : undefined
}

/** 缺 file 字段 / 不是 multipart 时统一 400；超过 multipart 的 fileSize 限制转 413。 */
const readPart = async (request: FastifyRequest): Promise<MultipartFile> => {
  let part: MultipartFile | undefined
  try {
    part = await request.file()
  } catch (error) {
    if (statusOf(error) === 413) {
      throw tooLarge(`文件超过 ${env.RAY_MAX_UPLOAD_MB} MB 上限`)
    }
    throw badRequest('上传请求必须是 multipart/form-data，且包含 file 字段')
  }
  if (!part) {
    throw badRequest('缺少 file 字段')
  }
  return part
}

/**
 * 读 multipart 里的 purpose 字段。前端上传时会在 file 之前带上它
 * （`rich_layout_recognition` / `user_data`），当前 schema 没有对应列，只用于限额。
 */
const readPurpose = (part: MultipartFile): string | null => {
  const field = part.fields['purpose']
  const value = Array.isArray(field) ? field[0] : field
  return value && value.type === 'field' && typeof value.value === 'string' ? value.value : null
}

/** 单文件上限：图片 20 MB、文本/代码/表格 32 MB、其余走 env.RAY_MAX_UPLOAD_MB（默认 64 MB）。 */
const maxBytesFor = (mime: string, purpose: string | null): number => {
  if (mime.startsWith('image/')) {
    return IMAGE_MAX_MB * MB
  }
  if (purpose === 'user_data') {
    return USER_DATA_MAX_MB * MB
  }
  return env.RAY_MAX_UPLOAD_MB * MB
}

/** multipart 的 filename 由客户端提供，只留文件名部分并去掉控制字符与引号。 */
const sanitizeFilename = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '_').trim().slice(0, 200)
  return cleaned.length > 0 ? cleaned : 'file'
}

const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

/** 一律以附件下载：带 ASCII 兜底名 + RFC 5987 的 UTF-8 名，中文文件名不会乱码。 */
const contentDisposition = (name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

const quotaError = (): ReturnType<typeof badRequest> =>
  badRequest(`User storage quota exceeded, limit ${STORAGE_LIMIT_LABEL}`)

/** 文件查不到（含 id 非法、无权限、磁盘文件丢失）：前端靠这段文案自动补传。 */
const missingFileError = (): ReturnType<typeof badRequest> =>
  badRequest('file_ids do not exist or are not created under your account')

/** 落盘成功但后续校验失败时清掉刚写的新文件；已存在的同内容文件与已登记的记录不能删。 */
const discardUpload = async (db: Db, stored: StoredUpload): Promise<void> => {
  if (stored.existed || findFile(db, stored.sha256)) {
    return
  }
  await unlinkQuietly(fileDiskPath(stored.sha256)).catch(() => undefined)
}

export const fileRoutes = async (app: FastifyInstance): Promise<void> => {
  /** 上传：流式算 sha256 落盘，同一内容只存一份，重复上传只加引用计数。 */
  app.post('/files', { preHandler: requireUser }, async (request) => {
    const part = await readPart(request)
    const purpose = readPurpose(part)
    const filename = sanitizeFilename(part.filename)
    const declaredMime = resolveUploadMime(filename, part.mimetype)

    // 配额先粗判一次，明显超额就不必把整个文件读完。
    if (storageUsedBytes(app.db) >= MAX_STORAGE_BYTES) {
      throw quotaError()
    }

    // 声明类型不可用时边流边留头部样本，流结束后再决定是不是文本。
    const sampled = declaredMime ? null : sampleHead(part.file)
    let stored: StoredUpload
    try {
      stored = await storeUpload(sampled ? sampled.stream : part.file)
    } catch (error) {
      if (statusOf(error) === 413) {
        throw tooLarge(`文件超过 ${env.RAY_MAX_UPLOAD_MB} MB 上限`)
      }
      throw error
    }

    if (part.file.truncated) {
      await discardUpload(app.db, stored)
      throw tooLarge(`文件超过 ${env.RAY_MAX_UPLOAD_MB} MB 上限`)
    }

    const mime =
      declaredMime ?? (sampled && looksLikeText(sampled.head()) ? 'text/plain' : null)
    if (!mime) {
      await discardUpload(app.db, stored)
      throw badRequest(`Failed to recognize the file: ${filename}`)
    }

    const limit = maxBytesFor(mime, purpose)
    if (stored.size > limit) {
      await discardUpload(app.db, stored)
      throw tooLarge(`文件超过 ${Math.round(limit / MB)} MB 上限`)
    }

    // 配额核算与登记放在同一事务里，避免并发上传把总量顶穿。
    try {
      const row = app.db.transaction(() => {
        const existing = findFile(app.db, stored.sha256)
        const used = storageUsedBytes(app.db) - (existing?.size ?? 0)
        if (used + stored.size > MAX_STORAGE_BYTES) {
          throw quotaError()
        }
        return registerFile(app.db, {
          sha256: stored.sha256,
          size: stored.size,
          mime,
          name: filename,
        })
      })()

      const body: FileObject = {
        id: row.sha256,
        type: 'file',
        size_bytes: row.size,
        created_at: row.created_at,
        filename: row.name,
        mime_type: row.mime,
      }
      return body
    } catch (error) {
      await discardUpload(app.db, stored)
      throw error
    }
  })

  /** 下载：流式返回原始字节，一律 attachment + nosniff。 */
  app.get('/files/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user!
    const raw = (request.params as { id?: unknown }).id
    const id = typeof raw === 'string' ? raw : ''
    if (!isSha256(id)) {
      throw missingFileError()
    }
    const row = findFile(app.db, id)
    if (!row || !canAccessFile(app.db, user.id, id)) {
      throw missingFileError()
    }

    const diskPath = fileDiskPath(id)
    const stat = await fs.promises.stat(diskPath).catch(() => null)
    if (!stat?.isFile()) {
      // 记录还在但磁盘文件丢了：同样提示"文件不存在"，前端会重新上传。
      throw missingFileError()
    }

    reply.header('content-type', row.mime)
    reply.header('content-length', String(stat.size))
    reply.header('content-disposition', contentDisposition(row.name))
    reply.header('x-content-type-options', 'nosniff')
    return reply.send(fs.createReadStream(diskPath))
  })

  /** 删除：ref_count - 1，归零则删磁盘与记录；幂等，永远 204。 */
  app.delete('/files/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = request.user!
    const raw = (request.params as { id?: unknown }).id
    const id = typeof raw === 'string' ? raw : ''

    if (isSha256(id) && findFile(app.db, id) && canAccessFile(app.db, user.id, id)) {
      const diskPath = releaseFile(app.db, id)
      if (diskPath) {
        try {
          await unlinkQuietly(diskPath)
        } catch (error) {
          // 记录已删，磁盘残留交给孤儿清理任务，不让请求失败。
          request.log.warn({ err: error, path: diskPath }, '删除附件失败')
        }
      }
    }
    return reply.code(204).send()
  })
}
