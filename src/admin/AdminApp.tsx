import { Button } from '../components/base/Button.js'
import { Toast } from '../components/base/Toast.js'
import { Skeleton } from './components/Skeleton.js'
import { signOutAdmin, useAdminAuth } from './auth.js'
import { copy } from './copy.js'
import { AdminShell } from './layout/AdminShell.js'
import styles from './AdminApp.module.css'

/**
 * 管理端根组件。
 *
 * 先校验身份（GET /api/me）：非管理员一律只看到无权限页，不渲染任何管理界面；
 * 校验通过后挂载 AdminShell，页面切换由 hash 路由负责。
 */
export const AdminApp = () => {
  const { state, retry } = useAdminAuth()

  if (state.status === 'ready') {
    return (
      <>
        <AdminShell user={state.user} onSignOut={() => void signOutAdmin()} />
        <Toast />
      </>
    )
  }

  return (
    <>
      <div className={styles.gate}>
        <div className={styles.panel}>
          <div className={styles.brand}>
            <span className={styles.brandName}>{copy.appName}</span>
            <span className={styles.brandTag}>{copy.appSubtitle}</span>
          </div>

          {state.status === 'checking' ? (
            <div className={styles.checking} role="status">
              <Skeleton width="132px" height={16} />
              <div className={styles.description}>{copy.auth.checking}</div>
            </div>
          ) : null}

          {state.status === 'anonymous' ? (
            <>
              <h1 className={styles.title}>{copy.auth.anonymousTitle}</h1>
              <p className={styles.description}>{copy.auth.anonymousDescription}</p>
              <div className={styles.actions}>
                <Button onClick={() => (window.location.href = '/')}>{copy.auth.goToChat}</Button>
                <Button variant="outlined" onClick={retry}>
                  {copy.auth.retry}
                </Button>
              </div>
            </>
          ) : null}

          {state.status === 'forbidden' ? (
            <>
              <h1 className={styles.title}>{copy.auth.forbiddenTitle}</h1>
              <p className={styles.description}>{copy.auth.forbiddenDescription}</p>
              <p className={styles.account}>{state.user.username}</p>
              <div className={styles.actions}>
                <Button variant="outlined" onClick={retry}>
                  {copy.auth.retry}
                </Button>
                <Button variant="outlined" onClick={() => void signOutAdmin()}>
                  {copy.auth.logout}
                </Button>
              </div>
            </>
          ) : null}

          {state.status === 'error' ? (
            <>
              <h1 className={styles.title}>{copy.auth.errorTitle}</h1>
              <p className={styles.description}>{state.message}</p>
              <div className={styles.actions}>
                <Button onClick={retry}>{copy.common.retry}</Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <Toast />
    </>
  )
}
