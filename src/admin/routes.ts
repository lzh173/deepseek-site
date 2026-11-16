import { useEffect, useState } from 'react'
import { copy } from './copy.js'

/** 管理端的七个页面；hash 形如 #/channels */
export type RouteKey = 'dashboard' | 'channels' | 'keys' | 'models' | 'users' | 'logs' | 'system'

export const routeKeys: RouteKey[] = [
  'dashboard',
  'channels',
  'keys',
  'models',
  'users',
  'logs',
  'system',
]

const isRouteKey = (value: string): value is RouteKey => routeKeys.some((route) => route === value)

export const parseHash = (): RouteKey => {
  const name = window.location.hash.replace(/^#\/?/, '')
  return isRouteKey(name) ? name : 'dashboard'
}

/**
 * 十几行的手写 hash 路由，不引路由库。
 * 返回当前页与一个跳转函数；地址栏始终与页面一致，刷新后仍停在原页。
 */
export const useRoute = (): { route: RouteKey; navigate: (route: RouteKey) => void } => {
  const [route, setRoute] = useState<RouteKey>(parseHash)

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHashChange)
    if (!window.location.hash) {
      window.location.replace(`#/${parseHash()}`)
    }
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title = `${copy.appName} ${copy.appSubtitle} · ${copy.nav[route]}`
  }, [route])

  return {
    route,
    navigate: (next) => {
      window.location.hash = `#/${next}`
      setRoute(next)
    },
  }
}
