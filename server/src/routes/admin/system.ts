import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { env } from '../../env.ts'
import { addDays } from '../../lib/time.ts'

/**
 * 管理端「系统」页：磁盘用量、各表行数、孤儿文件清理（GOAL.md §11.2、§14）。
 *
 * 文件按 sha256 内容寻址落在 <data>/files/<sha256>；ref_count = 0 且落库超过 24 小时
 * 的就是孤儿（上传后会话没写成功、或会话删除后引用归零却没被即时清理）。
 */

type DirStats = { count: number; bytes: number }

/** 取文件字节数；文件不存在（首次启动、WAL 未生成）按 0 算。 */
const fileSizeOf = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).size : 0)

/** 递归统计目录里的普通文件数与总字节。 */
const collectDir = (dir: string, stats: DirStats): DirStats => {
  if (!fs.existsSync(dir)) {
    return stats
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectDir(full, stats)
      continue
    }
    // 符号链接不计入：它指向的字节不归我们管，统计进去会虚高
    if (!entry.isFile()) {
      continue
    }
    stats.count += 1
    stats.bytes += fs.statSync(full).size
  }
  return stats
}

export const systemRoutes = async (app: FastifyInstance): Promise<void> => {
  /** 业务表清单每次现查：以后加迁移不用改这里。 */
  const tableNames = (): string[] =>
    (
      app.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'
           ORDER BY name ASC`
        )
        .all() as { name: string }[]
    ).map((row) => row.name)

  app.get('/system', async (request) => {
    const filesDir = path.join(env.dataDir, 'files')
    const files = collectDir(filesDir, { count: 0, bytes: 0 })

    const tables = tableNames().map((name) => {
      // 表名来自 sqlite_master，不是用户输入；仍按标识符规则加引号转义
      const quoted = `"${name.replace(/"/g, '""')}"`
      const { n } = app.db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }
      return { name, rows: n }
    })

    return {
      ray: request.ray,
      db: {
        path: env.dbPath,
        size_bytes: fileSizeOf(env.dbPath),
        // WAL 模式下未 checkpoint 的数据还在 -wal 里，单独列出来才看得懂真实占用
        wal_bytes: fileSizeOf(`${env.dbPath}-wal`),
      },
      files: { dir: filesDir, count: files.count, bytes: files.bytes },
      tables,
    }
  })

  app.post('/system/cleanup', async (request) => {
    // 24 小时是 GOAL.md §11.2 的孤儿判定窗口
    const cutoff = addDays(-1)
    const candidates = app.db
      .prepare('SELECT sha256, size FROM files WHERE ref_count = 0 AND created_at < ?')
      .all(cutoff) as { sha256: string; size: number }[]

    const filesDir = path.join(env.dataDir, 'files')

    const outcome = app.db.transaction(() => {
      let removed = 0
      let freed = 0
      const del = app.db.prepare('DELETE FROM files WHERE sha256 = ?')

      for (const row of candidates) {
        // 先删磁盘、再删行：反过来一旦删行成功而磁盘失败，这个文件就失去唯一索引，永远没人再来清它
        if (/^[0-9a-f]{64}$/i.test(row.sha256)) {
          try {
            fs.unlinkSync(path.join(filesDir, row.sha256))
          } catch (error) {
            // ENOENT 说明文件早已不在（如手工清过目录），继续删行即可；其他错误照常抛出
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error
            }
          }
        }
        del.run(row.sha256)
        removed += 1
        freed += row.size
      }

      return { removed, freed }
    })()

    return { ray: request.ray, removed: outcome.removed, freed_bytes: outcome.freed }
  })
}
