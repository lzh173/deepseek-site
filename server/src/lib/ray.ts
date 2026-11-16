import { randomBytes } from 'node:crypto'

/** 请求编号：ray_ + 12 位十六进制。所有错误信息里都要带上它。 */
export const newRay = (): string => `ray_${randomBytes(6).toString('hex')}`
