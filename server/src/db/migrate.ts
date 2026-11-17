import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './index.ts'
import { nowIso } from '../lib/time.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(here, 'migrations')

/**
 * 极简迁移器：按文件名顺序执行 migrations/*.sql，已执行过的记在 _migrations。
 * 不依赖 drizzle-kit / 任何代码生成，保证换机器直接可跑。
 */
export const migrate = (db: Db): void => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
  )
  const applied = new Set(
    db
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((row) => (row as { name: string }).name)
  )
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) {
      continue
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const run = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, nowIso())
    })
    run()
  }
}
