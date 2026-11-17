import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { LICENSE_ID, REPO_URL } from '../../about.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'
import about from './WelcomeAbout.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
        {/*
          AGPL-3.0 §13 的履约入口：首屏就给出来源链接，不藏在二级页面里。
          部署到别处时改 src/about.ts 里的 REPO_URL 即可。
        */}
        <div className={about.footer}>
          <a className={about.link} href={REPO_URL} target="_blank" rel="noreferrer noopener">
            {t('aboutRepoLabel')}
          </a>
          <span className={about.dot}>·</span>
          <a
            className={about.link}
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noreferrer noopener"
          >
            {LICENSE_ID}
          </a>
        </div>
      </div>
    </div>
  )
}
