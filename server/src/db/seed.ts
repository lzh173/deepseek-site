import { hash } from '@node-rs/argon2'
import type { Db } from './index.ts'
import { env } from '../env.ts'
import { encryptSecret, randomId, randomToken } from '../lib/crypto.ts'
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
    console.log(`[zhds] 已创建管理员：${env.RAY_ADMIN_USER}`)
  } else {
    console.log(
      `[zhds] 已创建管理员：${env.RAY_ADMIN_USER}，初始密码（仅显示一次）：${password}`
    )
  }
}

/**
 * 开发便利：配置了 RAY_UPSTREAM_* 且 models 表为空时，
 * 自动建一条「默认上游」渠道 + 一把 Key + 一个 ray-chat 模型，
 * 让第一次启动就能直接对话，不必先手动配渠道。
 */
export const seedUpstream = (db: Db): void => {
  const baseUrl = env.RAY_UPSTREAM_BASE_URL
  const apiKey = env.RAY_UPSTREAM_API_KEY
  if (!baseUrl || !apiKey) {
    return
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }
  if (n > 0) {
    return
  }

  const now = nowIso()
  const channelId = randomId('chn')
  const keyId = randomId('key')
  const upstreamModel = env.RAY_UPSTREAM_MODEL ?? 'deepseek-chat'

  db.transaction(() => {
    db.prepare(
      `INSERT INTO channels (id, name, kind, base_url, tier, priority, timeout_ms, concurrency, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(channelId, '默认上游', 'openai', baseUrl, 'free', 100, 120000, 4, 1, now)

    db.prepare(
      `INSERT INTO keys (id, channel_id, key_cipher, label, group_label, weight, status, cooldown_until, daily_quota, fail_count, last_ok_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(keyId, channelId, encryptSecret(apiKey), '默认 Key', null, 1, 'active', null, 1000, 0, null, now)

    db.prepare(
      `INSERT INTO models (id, display_name, context, caps_json, tier, fallback_chain_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ray-chat',
      'Ray Chat',
      32768,
      JSON.stringify({
        vision: false,
        reasoning: true,
        web_search: false,
        read_url: false,
        file_parse: true,
      }),
      'free',
      '[]',
      1
    )

    db.prepare(
      'INSERT INTO key_models (key_id, public_model, upstream_model, weight, enabled) VALUES (?, ?, ?, ?, ?)'
    ).run(keyId, 'ray-chat', upstreamModel, 1, 1)
  })()

  console.log(`[zhds] 已按 RAY_UPSTREAM_* 创建默认渠道、Key 与模型 ray-chat → ${upstreamModel}`)
}
