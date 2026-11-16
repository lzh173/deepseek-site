import { create } from 'zustand'
import {
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  type AuthUser,
} from './api/client.js'
import { clearLocalFileCache } from './chat/db.js'

/**
 * 登录态：BFF 用 HttpOnly Cookie 维持会话，前端只在内存里记住当前用户，
 * 刷新后由 GET /api/me 重新确认。未登录时 App 只渲染登录卡片。
 */
export type AuthStatus = 'checking' | 'anonymous' | 'authenticated'

type AuthState = {
  status: AuthStatus
  user: AuthUser | null
  /** GET /api/me 失败（通常是 BFF 没起或网络断了），登录卡片上给出提示与重试 */
  offline: boolean
}

export const useAuth = create<AuthState>(() => ({
  status: 'checking',
  user: null,
  offline: false,
}))

let checking: Promise<AuthUser | null> | undefined

/** 启动时确认登录态；并发调用共用同一个请求 */
export const checkAuth = (): Promise<AuthUser | null> => {
  if (checking) {
    return checking
  }
  useAuth.setState({ status: 'checking' })
  checking = fetchMe()
    .then((user) => {
      useAuth.setState({
        user,
        offline: false,
        status: user ? 'authenticated' : 'anonymous',
      })
      return user
    })
    .catch(() => {
      useAuth.setState({ user: null, offline: true, status: 'anonymous' })
      return null
    })
    .finally(() => {
      checking = undefined
    })
  return checking
}

/** 登录成功后写入内存状态；失败时把 ApiError 抛给表单展示 */
export const signIn = async (username: string, password: string): Promise<AuthUser> => {
  const user = await loginRequest(username, password)
  useAuth.setState({ user, status: 'authenticated', offline: false })
  return user
}

/** 退出登录：服务端清除 Cookie 后整页刷新，避免上一个用户的会话留在内存里 */
export const signOut = async (): Promise<void> => {
  await logoutRequest()
  clearLocalFileCache()
  useAuth.setState({ user: null, status: 'anonymous', offline: false })
  window.location.reload()
}
