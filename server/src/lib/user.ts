import type { Role } from '../db/types.ts'

/** 挂在 request.user 上的登录态；未登录为 null。 */
export type SessionUser = {
  id: string
  username: string
  role: Role
  dailyQuota: number
}
