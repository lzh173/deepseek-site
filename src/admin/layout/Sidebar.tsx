import clsx from 'clsx'
import type { ReactNode } from 'react'
import {
  IconCheckedOutline14,
  IconDataOutline16,
  IconGlobeLanguageOutline14,
  IconLinkOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
} from '../../components/base/icons.js'
import { copy } from '../copy.js'
import type { RouteKey } from '../routes.js'
import styles from './Sidebar.module.css'

type NavItem = { route: RouteKey; label: string; icon: ReactNode }

/** 图标取自 components/base/icons.tsx，不新增图标库 */
const navItems: NavItem[] = [
  { route: 'dashboard', label: copy.nav.dashboard, icon: <IconDataOutline16 /> },
  { route: 'channels', label: copy.nav.channels, icon: <IconLinkOutline16 /> },
  { route: 'keys', label: copy.nav.keys, icon: <IconCheckedOutline14 /> },
  { route: 'models', label: copy.nav.models, icon: <IconThinkOutline16 /> },
  { route: 'users', label: copy.nav.users, icon: <IconGlobeLanguageOutline14 /> },
  { route: 'logs', label: copy.nav.logs, icon: <IconSearchOutline16 /> },
  { route: 'system', label: copy.nav.system, icon: <IconSettingsOutline16 /> },
]

/** 左侧导航：品牌 + 七个页面 + 返回聊天 */
export const Sidebar = ({
  route,
  onNavigate,
}: {
  route: RouteKey
  onNavigate: (route: RouteKey) => void
}) => (
  <aside className={styles.sidebar}>
    <div className={styles.brand}>
      <span className={styles.brandName}>{copy.appName}</span>
      <span className={styles.brandTag}>{copy.appSubtitle}</span>
    </div>
    <nav className={styles.nav} aria-label={copy.appSubtitle}>
      {navItems.map((item) => (
        <a
          key={item.route}
          href={`#/${item.route}`}
          className={clsx(styles.navItem, item.route === route && styles.navItemActive)}
          aria-current={item.route === route ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault()
            onNavigate(item.route)
          }}
        >
          <span className={styles.navIcon}>{item.icon}</span>
          <span className={styles.navLabel}>{item.label}</span>
        </a>
      ))}
    </nav>
    <div className={styles.footer}>
      <a className={styles.backLink} href="/">
        {copy.backToChat}
      </a>
    </div>
  </aside>
)
