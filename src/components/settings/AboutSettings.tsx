import { useTranslate } from '../../i18n/index.js'
import { ABOUT_LINKS, LICENSE_ID, PRODUCT_NAME, appVersion } from '../../about.js'
import styles from './Settings.module.css'
import about from './AboutSettings.module.css'

/**
 * 「关于」分区。
 *
 * 同时承担 AGPL-3.0 第 13 条的履约入口：本项目通过网络提供服务，
 * 用户必须能从这里找到完整源码（REPO_URL），以及许可全文与上游归属。
 */
export const AboutSettings = () => {
  const t = useTranslate()

  return (
    <>
      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{PRODUCT_NAME}</div>
          <div className={styles.description}>
            {t('aboutTagline')} · {t('aboutVersion')} {appVersion()}
          </div>
        </div>
      </div>

      {ABOUT_LINKS.map((link) => (
        <div key={link.key} className={`${styles.cell} ${styles.row}`}>
          <div className={styles.text}>
            <div className={styles.label}>{t(link.labelKey)}</div>
            <div className={styles.description}>{t(link.hintKey)}</div>
          </div>
          <a className={about.link} href={link.href} target="_blank" rel="noreferrer noopener">
            {t('aboutOpen')}
          </a>
        </div>
      ))}

      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('aboutLicenseLabel')}</div>
          <div className={styles.description}>{t('aboutLicenseNotice')}</div>
        </div>
        <span className={about.badge}>{LICENSE_ID}</span>
      </div>
    </>
  )
}
