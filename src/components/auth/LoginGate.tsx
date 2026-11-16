import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { checkAuth, signIn, useAuth } from '../../services/auth.js'
import { loadModels } from '../../services/models.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './LoginGate.module.css'

/**
 * 登录闸门：应用启动时先问 GET /api/me，没有登录态就只渲染一层登录卡片。
 * 登录成功后先拉模型列表再渲染聊天主界面，保证首次发送时模型 id 已经就绪。
 * 会话 Cookie 过期后，聊天里的「重新登录」会重新走一次 checkAuth，卡片自动出现。
 */
export const LoginGate = ({ children }: { children: ReactNode }) => {
  const t = useTranslate()
  const status = useAuth((state) => state.status)
  const offline = useAuth((state) => state.offline)

  useEffect(() => {
    void checkAuth()
  }, [])

  useEffect(() => {
    if (status === 'authenticated') {
      void loadModels()
    }
  }, [status])

  if (status === 'authenticated') {
    return <>{children}</>
  }

  if (status === 'checking') {
    return (
      <div className={styles.screen} role="status" aria-live="polite">
        <span className={styles.loading}>{t('appLoading')}</span>
      </div>
    )
  }

  return <LoginCard offline={offline} />
}

/** 登录卡片：复用 base 的 Modal / Button 与 theme.css 的设计令牌，暗色自动跟随 */
const LoginCard = ({ offline }: { offline: boolean }) => {
  const t = useTranslate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const name = username.trim()
    if (busy || !name || !password) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIn(name, password)
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? t('loginFailed', { message: cause.message })
          : t('loginFailed', { message: t('unknownError') })
      )
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      void submit()
    }
  }

  return (
    <Modal
      title={t('loginTitle')}
      // 未登录时没有可关闭的目标，遮罩与 Esc 都不做处理
      onClose={() => {}}
      footer={
        <>
          {offline ? (
            <Button variant="outlined" disabled={busy} onClick={() => void checkAuth()}>
              {t('retry')}
            </Button>
          ) : null}
          <Button disabled={busy || !username.trim() || !password} onClick={() => void submit()}>
            {t(busy ? 'loginSubmitting' : 'loginSubmit')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.hint}>
          {offline ? t('loginServerOffline') : t('loginDescription')}
        </p>
        <label className={styles.field}>
          <span className={styles.label}>{t('loginUsername')}</span>
          <input
            className={styles.input}
            name="username"
            autoComplete="username"
            spellCheck={false}
            autoFocus
            disabled={busy}
            placeholder={t('loginUsernamePlaceholder')}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={onEnter}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('loginPassword')}</span>
          <input
            className={styles.input}
            name="password"
            type="password"
            autoComplete="current-password"
            disabled={busy}
            placeholder={t('loginPasswordPlaceholder')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={onEnter}
          />
        </label>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
