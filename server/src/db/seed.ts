import { hash } from '@node-rs/argon2'
import type { Db } from './index.ts'
import { env } from '../env.ts'
import { randomId, randomToken } from '../lib/crypto.ts'
import { nowIso } from '../lib/time.ts'

/**
 * 首次启动时创建管理员。密码来自 RAY_ADMIN_PASSWORD；
 * 未配置则随机生成并在控制台打印一次（不会再次显示）。
 */
export const seedAdmin = async (db: Db): Promise<void> => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (n > 0) {
    return
  }

  const provided = env.RAY_ADMIN_PASSWORD
  const password = provided ?? randomToken().slice(0, 16)
  const passHash = await hash(password)

  db.prepare(
    'INSERT INTO users (id, username, pass_hash, role, enabled, daily_quota, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    randomId('usr'),
    env.RAY_ADMIN_USER,
    passHash,
    'admin',
    1,
    0,
    nowIso()
  )

  if (provided) {
    console.log(`[ray] 已创建管理员：${env.RAY_ADMIN_USER}`)
  } else {
    console.log(
      `[ray] 已创建管理员：${env.RAY_ADMIN_USER}，初始密码（仅显示一次）：${password}`
    )
  }
}
