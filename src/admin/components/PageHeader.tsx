import type { ReactNode } from 'react'
import styles from './PageHeader.module.css'

/** 页面标题区：标题 + 一句说明 + 右侧操作 */
export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) => (
  <header className={styles.header}>
    <div className={styles.text}>
      <h1 className={styles.title}>{title}</h1>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
    {actions ? <div className={styles.actions}>{actions}</div> : null}
  </header>
)
