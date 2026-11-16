import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { env } from '../env.ts'
import { migrate } from './migrate.ts'

export type Db = Database.Database

/** 打开（必要时创建）数据库并跑完迁移。全进程一个实例。 */
export const openDb = (): Db => {
  fs.mkdirSync(env.dataDir, { recursive: true })
  const db = new Database(env.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}
