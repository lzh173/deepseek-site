import { useEffect, useState } from 'react'
import { api, errorMessage, type AdminUser } from './api.js'

/**
 * 启动时的身份校验：GET /api/me。
 *
 * 未登录 → 提示去主站登录；已登录但不是 admin → 无权限页（不把管理接口的错误当成这里的结果）。
 * 校验失败（BFF 没起、网络断）单独成一种状态，避免把"连不上"误报成"未登录"。
 */
export type AdminAuthState =
  | { status: 'checking' }
  | { status: 'ready'; user: AdminUser }
  | { status: 'anonymous' }
  | { status: 'forbidden'; user: AdminUser }
  | { status: 'error'; message: string }

const resolve = (user: AdminUser | null): AdminAuthState => {
  if (!user) {
    return { status: 'anonymous' }
  }
  return user.role === 'admin' ? { status: 'ready', user } : { status: 'forbidden', user }
}

export const useAdminAuth = (): { state: AdminAuthState; retry: () => void } => {
  const [state, setState] = useState<AdminAuthState>({ status: 'checking' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setState({ status: 'checking' })
    void api
      .me()
      .then((result) => {
        if (active) {
          setState(resolve(result.user))
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ status: 'error', message: errorMessage(error) })
        }
      })
    return () => {
      active = false
    }
  }, [attempt])

  return {
    state,
    retry: () => setAttempt((value) => value + 1),
  }
}

/** 退出登录后整页刷新：管理端与主站共用 Cookie，刷新后回到未登录状态 */
export const signOutAdmin = async (): Promise<void> => {
  await api.logout()
  window.location.reload()
}
