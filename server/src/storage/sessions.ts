import type { Db } from '../db/index.ts'
import type { SessionRow } from '../db/types.ts'
import { badRequest, notFound, tooLarge } from '../lib/errors.ts'
import { nowIso } from '../lib/time.ts'
import {
  decrementFileRef,
  deleteFileRow,
  fileDiskPath,
  incrementFileRef,
  isSha256,
  unlinkQuietly,
} from './files.ts'

/**
 * 会话存储：整棵会话树以字符串化 JSON 存在 `sessions.payload`，
 * 与前端 IndexedDB 的 `Session` 结构一一对应（GOAL.md §11.2）。
 *
 * 只做三件事：
 *   1. 增删改查，且**所有查询都带 user_id**，不跨用户；
 *   2. payload 里引用到的附件同步到 `session_files`，并维护 `files.ref_count`；
 *   3. 限额：单会话 payload 8 MB、列表最多 2000 条、单条消息最多 50 个附件。
 */

/** 单个会话 payload 上限 8 MB（任务约定；请求体上限 35 MB 由 Fastify 兜底）。 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

/** 列表最多返回 2000 条摘要（GOAL.md §11.1）。 */
export const MAX_LISTED_SESSIONS = 2000

/** 单条消息附件数上限；超限文案必须能被前端正则匹配（GOAL.md §6.4）。 */
export const MAX_MESSAGE_FILES = 50

/** 列表用的会话摘要。字段保持 snake_case，与前端 HTTP 实现约定一致。 */
export type SessionSummaryDto = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

/** 会话详情，payload 是原样存回的整棵会话树字符串。 */
export type SessionDetailDto = SessionSummaryDto & { payload: string }

export type SaveSessionInput = {
  /** 缺省表示"只更新 payload，标题保持原样"；新建时缺省为空标题 */
  title?: string
  payload: string
}

const toSummary = (row: SessionRow): SessionSummaryDto => ({
  id: row.id,
  title: row.title,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const toDetail = (row: SessionRow): SessionDetailDto => ({
  ...toSummary(row),
  payload: row.payload,
})

/** 当前用户的会话摘要，按 updated_at 倒序，最多 2000 条。 */
export const listSessions = (db: Db, userId: string): SessionSummaryDto[] =>
  db
    .prepare(
      `SELECT id, title, created_at, updated_at
       FROM sessions
       WHERE user_id = ?
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`
    )
    .all(userId, MAX_LISTED_SESSIONS) as SessionSummaryDto[]

/** 读一个会话；不属于该用户时返回 null（路由层转 404，不泄露存在性）。 */
export const findSession = (db: Db, userId: string, id: string): SessionDetailDto | null => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(id, userId) as
    | SessionRow
    | undefined
  return row ? toDetail(row) : null
}

/** 附件对象里可能承载 sha256 的字段：本地 id、Files API 的 serverId，以及显式 sha256。 */
const FILE_ID_KEYS = new Set(['id', 'serverId', 'server_id', 'sha256'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 深度遍历 payload，收集附件引用。
 * 前端附件形状是 `{ id, serverId, name, size, isImage, mimeType }`，其中真正的服务端 id
 * 落在 `serverId`；这里同时接受 `id`，随后靠"64 位 hex + files 表里确实有"双重过滤，
 * 消息 id（UUID）之类的字符串不会误命中。
 */
const collectRefs = (value: unknown, out: Set<string>, depth = 0): void => {
  if (depth > 64) {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, out, depth + 1)
    }
    return
  }
  if (!isRecord(value)) {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'files' && Array.isArray(child) && child.length > MAX_MESSAGE_FILES) {
      // 文案必须命中前端 `/User file count limit exceeded.*?limit (\d+)/i`（GOAL.md §6.4）。
      throw badRequest(
        `User file count limit exceeded: a message can carry at most ${MAX_MESSAGE_FILES} files (limit ${MAX_MESSAGE_FILES})`
      )
    }
    if (typeof child === 'string') {
      if (FILE_ID_KEYS.has(key) && isSha256(child)) {
        out.add(child)
      }
      continue
    }
    collectRefs(child, out, depth + 1)
  }
}

/** 解析 payload 并取出其中被引用的文件 id；payload 不是合法 JSON 直接 400。 */
const payloadFileIds = (payload: string): string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw badRequest('会话数据不是合法的 JSON')
  }
  const out = new Set<string>()
  collectRefs(parsed, out)
  return [...out]
}

/** 只保留 files 表里真实存在的 sha256，避免 session_files 的外键失败。 */
const knownFileIds = (db: Db, ids: string[]): string[] => {
  const known: string[] = []
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT sha256 FROM files WHERE sha256 IN (${placeholders})`)
      .all(...chunk) as { sha256: string }[]
    for (const row of rows) {
      known.push(row.sha256)
    }
  }
  return known
}

/**
 * 同步一个会话的附件引用：新增的建行并 +1，去掉的删行并 -1。
 * 归零后**保留** files 记录与磁盘文件（前端可能马上又加回来），
 * 真正的回收交给"无引用附件保留 7 天"的清理任务。
 */
const syncSessionFiles = (db: Db, sessionId: string, fileIds: string[]): void => {
  const previous = new Set(
    (
      db.prepare('SELECT sha256 FROM session_files WHERE session_id = ?').all(sessionId) as {
        sha256: string
      }[]
    ).map((row) => row.sha256)
  )
  const next = new Set(knownFileIds(db, fileIds))

  for (const sha256 of previous) {
    if (next.has(sha256)) {
      continue
    }
    db.prepare('DELETE FROM session_files WHERE session_id = ? AND sha256 = ?').run(
      sessionId,
      sha256
    )
    decrementFileRef(db, sha256)
  }
  for (const sha256 of next) {
    if (previous.has(sha256)) {
      continue
    }
    db.prepare('INSERT OR IGNORE INTO session_files (session_id, sha256) VALUES (?, ?)').run(
      sessionId,
      sha256
    )
    incrementFileRef(db, sha256)
  }
}

/**
 * upsert：会话不存在则创建，存在则整体覆盖 payload（`title` 缺省时保留原标题）。
 * 同一事务里完成写入与附件引用同步。
 */
export const saveSession = (
  db: Db,
  userId: string,
  id: string,
  input: SaveSessionInput
): { session: SessionDetailDto; created: boolean } => {
  if (Buffer.byteLength(input.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw tooLarge(`会话数据超过 ${MAX_PAYLOAD_BYTES / 1024 / 1024} MB 上限`)
  }
  const fileIds = payloadFileIds(input.payload)

  const run = db.transaction((): { session: SessionDetailDto; created: boolean } => {
    const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined

    // id 与别人冲突时按"不存在"处理：既不能覆盖，也不告诉调用方这个 id 存在。
    if (existing && existing.user_id !== userId) {
      throw notFound('会话不存在')
    }

    const now = nowIso()
    if (existing) {
      const title = input.title ?? existing.title
      db.prepare(
        'UPDATE sessions SET title = ?, payload = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      ).run(title, input.payload, now, id, userId)
    } else {
      db.prepare(
        'INSERT INTO sessions (id, user_id, title, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, userId, input.title ?? '', input.payload, now, now)
    }

    syncSessionFiles(db, id, fileIds)

    const row = db
      .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
      .get(id, userId) as SessionRow | undefined
    if (!row) {
      throw notFound('会话不存在')
    }
    return { session: toDetail(row), created: !existing }
  })

  return run()
}

/**
 * 只改标题。不更新 updated_at：与前端原 IndexedDB 实现一致（重命名不改变列表顺序）。
 * 会话不存在或不属于该用户时返回 null。
 */
export const renameSession = (
  db: Db,
  userId: string,
  id: string,
  title: string
): SessionDetailDto | null => {
  const result = db
    .prepare('UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?')
    .run(title, id, userId)
  return result.changes > 0 ? findSession(db, userId, id) : null
}

/**
 * 删除会话并回收附件引用：删 session（级联删 session_files），逐个 `ref_count - 1`，
 * 归零的记录连同磁盘文件一起删掉（GOAL.md §11.1「会话删除：立即减引用，归零即删文件」）。
 * 磁盘操作放在事务提交之后。
 */
export const deleteSession = async (db: Db, userId: string, id: string): Promise<boolean> => {
  const run = db.transaction((): { deleted: boolean; unlink: string[] } => {
    const owned = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(id, userId)
    if (!owned) {
      return { deleted: false, unlink: [] }
    }
    const refs = db.prepare('SELECT sha256 FROM session_files WHERE session_id = ?').all(id) as {
      sha256: string
    }[]
    db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId)

    const unlink: string[] = []
    for (const ref of refs) {
      if (decrementFileRef(db, ref.sha256) === 0 && deleteFileRow(db, ref.sha256)) {
        unlink.push(fileDiskPath(ref.sha256))
      }
    }
    return { deleted: true, unlink }
  })

  const { deleted, unlink } = run()
  for (const filePath of unlink) {
    // 事务已提交，磁盘删失败不应让请求失败；残留文件由孤儿清理任务兜底。
    await unlinkQuietly(filePath).catch(() => undefined)
  }
  return deleted
}
