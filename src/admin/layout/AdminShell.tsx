import { useEffect, useRef } from 'react'
import type { AdminUser } from '../api.js'
import { useRoute } from '../routes.js'
import { Channels } from '../pages/Channels.js'
import { Dashboard } from '../pages/Dashboard.js'
import { Keys } from '../pages/Keys.js'
import { Logs } from '../pages/Logs.js'
import { Models } from '../pages/Models.js'
import { System } from '../pages/System.js'
import { Users } from '../pages/Users.js'
import { Sidebar } from './Sidebar.js'
import { Topbar } from './Topbar.js'
import styles from './AdminShell.module.css'

/** 外壳：左侧栏 + 顶栏 + 可滚动的内容区 */
export const AdminShell = ({ user, onSignOut }: { user: AdminUser; onSignOut: () => void }) => {
  const { route, navigate } = useRoute()
  const scrollRef = useRef<HTMLDivElement>(null)

  // 切页后回到顶部，避免沿用上一页的滚动位置
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [route])

  return (
    <div className={styles.shell}>
      <Sidebar route={route} onNavigate={navigate} />
      <div className={styles.main}>
        <Topbar route={route} user={user} onSignOut={onSignOut} />
        <div ref={scrollRef} className={styles.scroll}>
          <div className={styles.page}>{renderRoute(route)}</div>
        </div>
      </div>
    </div>
  )
}

const renderRoute = (route: ReturnType<typeof useRoute>['route']) => {
  switch (route) {
    case 'channels':
      return <Channels />
    case 'keys':
      return <Keys />
    case 'models':
      return <Models />
    case 'users':
      return <Users />
    case 'logs':
      return <Logs />
    case 'system':
      return <System />
    case 'dashboard':
      return <Dashboard />
    default:
      return <Dashboard />
  }
}
