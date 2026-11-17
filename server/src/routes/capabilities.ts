import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { badRequest, forbidden } from '../lib/errors.ts'
import type { SessionUser } from '../lib/user.ts'
import { requireUser } from '../plugins/auth.ts'
import { canUseOfficialTools } from '../caps/official.ts'
import { officialOcr } from '../caps/ocr.ts'
import { findFile, fileDiskPath } from '../storage/files.ts'
import {
  capabilityPrefsRoutes,
  isDisabled,
  readCapabilityPrefs,
  wantsBrowser,
} from '../caps/prefs.ts'

/**
 * 能力探测：前端「设置」页用它决定哪些开关可用、走服务端还是浏览器兜底。
 *
 * 三类账号看到的矩阵不同：
 * - 免费账号（user 且无 grants）：只能用免费渠道的对话；语音/OCR 走浏览器本地能力
 * - 授权账号（有 grants）：额外解锁官方 Search / Fetch / TTS / ASR / OCR / 文档解析
 * - 管理员：全部能力，且可以使用付费模型
 */
export const capabilityRoutes = async (app: FastifyInstance): Promise<void> => {
  const describe = (user: SessionUser) => ({
    tier: user.role === 'admin' ? 'admin' : 'user',
    official: {
      search: canUseOfficialTools(app, user, 'search'),
      fetch: canUseOfficialTools(app, user, 'fetch'),
      tts: canUseOfficialTools(app, user, 'tts'),
      asr: canUseOfficialTools(app, user, 'asr'),
      ocr: canUseOfficialTools(app, user, 'ocr'),
      document: canUseOfficialTools(app, user, 'document'),
    },
    browser: {
      // 浏览器兜底永远可用（不受账号限制），前端据此在官方能力不可用时降级
      speechRecognition: true,
      speechSynthesis: true,
    },
  })

  app.get('/capabilities', { preHandler: requireUser }, async (request) => ({
    ray: request.ray,
    ...describe(request.user!),
    prefs: readCapabilityPrefs(app, request.user!.id),
  }))

  await app.register(capabilityPrefsRoutes)

  /**
   * 独立 OCR：上传即识别，不进入对话。
   * 前端「设置 → 能力」页可以直接拖文件试一下，也方便把 OCR 结果贴进输入框。
   */
  app.post('/ocr', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    if (isDisabled(app, user, 'ocr')) {
      throw forbidden('OCR 已在设置里关闭')
    }
    if (!canUseOfficialTools(app, user, 'ocr')) {
      throw forbidden('OCR 需要管理员或授权账号')
    }
    const file = await request.file().catch(() => null)
    if (!file) {
      throw badRequest('缺少 file 字段（multipart/form-data）')
    }
    const buffer = await file.toBuffer()
    if (buffer.byteLength === 0) {
      throw badRequest('文件为空')
    }
    const result = await officialOcr(
      app,
      user,
      buffer,
      file.filename || 'upload.bin',
      file.mimetype || 'application/octet-stream',
      AbortSignal.timeout(180_000),
      request.log
    )
    if (!result) {
      throw badRequest('识别失败：文件无法解析或官方 OCR 不可用')
    }
    return { ray: request.ray, text: result.text, pages: result.pages }
  })

  /** 重新识别一个已上传的附件（管理页/设置页用） */
  app.post('/ocr/:fileId', { preHandler: requireUser }, async (request) => {
    const user = request.user!
    const { fileId } = request.params as { fileId: string }
    if (!canUseOfficialTools(app, user, 'ocr')) {
      throw forbidden('OCR 需要管理员或授权账号')
    }
    const row = findFile(app.db, fileId)
    if (!row) {
      throw badRequest('file_ids do not exist or are not created under your account')
    }
    const bytes = await readFile(fileDiskPath(row.sha256)).catch(() => null)
    if (!bytes) {
      throw badRequest('文件内容已丢失')
    }
    const result = await officialOcr(
      app,
      user,
      bytes,
      row.name,
      row.mime,
      AbortSignal.timeout(180_000),
      request.log
    )
    if (!result) {
      throw badRequest('识别失败：文件无法解析或官方 OCR 不可用')
    }
    return { ray: request.ray, text: result.text, pages: result.pages }
  })
}
