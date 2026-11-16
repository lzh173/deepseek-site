import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { env } from '../env.ts'

const ALGO = 'aes-256-gcm'
let cachedKey: Buffer | null = null

/**
 * 主密钥解析顺序：RAY_MASTER_KEY（64 位 hex 或任意口令经 scrypt 派生）
 * → <data>/.master-key（首次运行自动生成，0600）。
 * 密钥永不入库、永不回传前端。
 */
const resolveKey = (): Buffer => {
  if (cachedKey) {
    return cachedKey
  }
  const configured = env.RAY_MASTER_KEY
  if (configured) {
    cachedKey = /^[0-9a-fA-F]{64}$/.test(configured)
      ? Buffer.from(configured, 'hex')
      : scryptSync(configured, 'ray-master-key', 32)
    return cachedKey
  }
  const file = path.join(env.dataDir, '.master-key')
  fs.mkdirSync(env.dataDir, { recursive: true })
  if (fs.existsSync(file)) {
    cachedKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex')
    return cachedKey
  }
  const generated = randomBytes(32)
  fs.writeFileSync(file, generated.toString('hex'), { mode: 0o600 })
  cachedKey = generated
  return generated
}

/** 加密后的格式：v1.<iv b64>.<tag b64>.<cipher b64> */
export const encryptSecret = (plain: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, resolveKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.')
}

export const decryptSecret = (stored: string): string => {
  const [version, ivB64, tagB64, dataB64] = stored.split('.')
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('密钥密文格式不正确')
  }
  const decipher = createDecipheriv(ALGO, resolveKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** 列表展示用：保留前 3 位与后 4 位。 */
export const maskSecret = (plain: string): string => {
  if (plain.length <= 10) {
    return '••••'
  }
  return `${plain.slice(0, 3)}••••${plain.slice(-4)}`
}

/** 会话 token 只存哈希，数据库泄露也拿不到可用 token。 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export const randomToken = (): string => randomBytes(32).toString('base64url')

export const randomId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('hex')}`
