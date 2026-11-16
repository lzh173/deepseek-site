import { useTheme } from '../../app/theme.js'
import { Button } from '../../components/base/Button.js'
import { IconButton } from '../../components/base/IconButton.js'
import {
  IconDarkOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
} from '../../components/base/icons.js'
import { Menu, type MenuOption } from '../../components/base/Menu.js'
import { setThemePreference } from '../../services/settings.js'
import type { AdminUser } from '../api.js'
import { copy } from '../copy.js'
import type { RouteKey } from '../routes.js'
import { Tag } from '../components/Tag.js'
import styles from './Topbar.module.css'

const themeOptions: MenuOption[] = [
  {
    key: 'light',
    label: copy.auth.theme.light,
    icon: <IconLightOutline16 />,
    onSelect: () => setThemePreference('light'),
  },
  {
    key: 'dark',
    label: copy.auth.theme.dark,
    icon: <IconDarkOutline16 />,
    onSelect: () => setThemePreference('dark'),
  },
  {
    key: 'system',
    label: copy.auth.theme.system,
    icon: <IconFollowsystemOutline16 />,
    onSelect: () => setThemePreference('system'),
  },
]

/** 顶栏：面包屑 + 主题切换 + 当前管理员 + 退出 */
export const Topbar = ({
  route,
  user,
  onSignOut,
}: {
  route: RouteKey
  user: AdminUser
  onSignOut: () => void
}) => {
  const theme = useTheme()
  return (
    <header className={styles.topbar}>
      <div className={styles.crumbs}>
        <span className={styles.crumbRoot}>
          {copy.appName} {copy.appSubtitle}
        </span>
        <span className={styles.separator}>/</span>
        <span className={styles.crumbCurrent}>{copy.nav[route]}</span>
      </div>
      <div className={styles.actions}>
        <Menu options={themeOptions}>
          {({ open, toggle }) => (
            <IconButton
              size="m"
              aria-expanded={open}
              tooltip={copy.auth.theme.label}
              icon={theme === 'dark' ? <IconDarkOutline16 /> : <IconLightOutline16 />}
              onClick={toggle}
            />
          )}
        </Menu>
        <span className={styles.user}>
          <span className={styles.avatar}>{user.username.slice(0, 1).toUpperCase()}</span>
          <span className={styles.userName}>{user.username}</span>
          <Tag tone="brand">{copy.auth.roleAdmin}</Tag>
        </span>
        <Button variant="outlined" size="s" onClick={onSignOut}>
          {copy.auth.logout}
        </Button>
      </div>
    </header>
  )
}
