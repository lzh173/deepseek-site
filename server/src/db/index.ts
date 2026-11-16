import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { env } from '../env.ts'
import { migrate } from './migrate.ts'

/**
 * 为什么用内置的 node:sqlite 而不是 better-sqlite3：
 * Node 24 + ESM 下 better-sqlite3 的 Statement 终结器会在 GC 时触发
 * `RemoveEnvironmentCleanupHook (env) != nullptr` 的 native abort（可稳定复现）。
 * node:sqlite 没有原生扩展，既避开这个崩溃，也让镜像不需要编译工具链。
 *
 * 这里把 node:sqlite 适配成 better-sqlite3 的风格（prepare/get/all/run/transaction），
 * 这样上层代码不需要感知底层实现。
 */
type SqlValue = null | number | bigint | string | Uint8Array

export type RunResult = { changes: number; lastInsertRowid: number | bigint }

export type Statement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): RunResult
}

export type Db = {
  prepare(sql: string): Statement
  exec(sql: string): void
  /** 与 better-sqlite3 一致：返回一个可调用的包装函数，调用时才真正开启事务。 */
  transaction<T>(fn: () => T): () => T
  close(): void
}

/** node:sqlite 只接受 null/number/bigint/string/Uint8Array，这里把 boolean/undefined 归一化。 */
const normalize = (value: unknown): SqlValue => {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value
  }
  if (value instanceof Uint8Array) {
    return value
  }
  return String(value)
}

type RawStatement = {
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

export const openDb = (): Db => {
  fs.mkdirSync(env.dataDir, { recursive: true })
  const raw = new DatabaseSync(env.dbPath)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')

  const db: Db = {
    prepare(sql: string): Statement {
      const stmt = raw.prepare(sql) as unknown as RawStatement
      return {
        get: (...params: unknown[]) => stmt.get(...params.map(normalize)),
        all: (...params: unknown[]) => stmt.all(...params.map(normalize)),
        run: (...params: unknown[]) => {
          const result = stmt.run(...params.map(normalize))
          return {
            changes: Number(result.changes ?? 0),
            lastInsertRowid: result.lastInsertRowid,
          }
        },
      }
    },
    exec: (sql: string) => {
      raw.exec(sql)
    },
    transaction<T>(fn: () => T): () => T {
      // 不支持嵌套事务；当前所有调用点都是扁平的。
      return () => {
        raw.exec('BEGIN')
        try {
          const result = fn()
          raw.exec('COMMIT')
          return result
        } catch (error) {
          try {
            raw.exec('ROLLBACK')
          } catch {
            // 事务可能已被 SQLite 自动回滚
          }
          throw error
        }
      }
    },
    close: () => {
      raw.close()
    },
  }

  migrate(db)
  return db
}
