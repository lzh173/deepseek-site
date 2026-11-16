import type { FastifyInstance } from 'fastify'
import { reviveCoolingKeys } from '../pool/index.ts'
import { fileDiskPath, unlinkQuietly } from '../storage/files.ts'

const HOUR = 60 * 60 * 1000
const ORPHAN_TTL_MS = 24 * HOUR

/**
 * 清理孤儿文件：`ref_count = 0` 且创建超过 24 小时。
 * 先删磁盘再删行；删行时再确认一次 ref_count，避免与并发的会话写入竞争。
 */
const cleanupOrphans = async (app: FastifyInstance): Promise<number> => {
  const cutoff = new Date(Date.now() - ORPHAN_TTL_MS).toISOString()
  const rows = app.db
    .prepare('SELECT sha256 FROM files WHERE ref_count = 0 AND created_at < ?')
    .all(cutoff) as { sha256: string }[]

  for (const row of rows) {
    await unlinkQuietly(fileDiskPath(row.sha256))
    app.db.prepare('DELETE FROM files WHERE sha256 = ? AND ref_count = 0').run(row.sha256)
  }

  if (rows.length > 0) {
    app.log.info({ removed: rows.length }, '[ray] 已清理孤儿文件')
  }
  return rows.length
}

/**
 * 定时任务：
 * - 每 60 秒把冷却到期的 Key 拉回 active
 * - 每小时清理一次孤儿文件
 */
export const startJobs = (app: FastifyInstance): void => {
  const reviveTimer = setInterval(() => {
    try {
      reviveCoolingKeys(app)
    } catch (error) {
      app.log.error({ err: error }, 'revive cooling keys failed')
    }
  }, 60_000)

  const cleanupTimer = setInterval(() => {
    void cleanupOrphans(app).catch((error: unknown) => {
      app.log.error({ err: error }, 'orphan cleanup failed')
    })
  }, HOUR)

  // 不阻塞进程退出
  reviveTimer.unref()
  cleanupTimer.unref()

  app.addHook('onClose', async () => {
    clearInterval(reviveTimer)
    clearInterval(cleanupTimer)
  })
}
