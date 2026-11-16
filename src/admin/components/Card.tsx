import clsx from 'clsx'
import type { ReactNode } from 'react'
import styles from './Card.module.css'

/**
 * 内容卡片：管理端的基本容器。
 * flush 用于表格——去掉内边距让表格贴边，单元格自带左右留白。
 */
export const Card = ({
  title,
  description,
  actions,
  flush = false,
  className,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  flush?: boolean
  className?: string
  children?: ReactNode
}) => {
  const header = title || description || actions
  return (
    <section className={clsx(styles.card, flush && styles.flush, className)}>
      {header ? (
        <header className={clsx(styles.header, flush && styles.headerFlush)}>
          <div className={styles.text}>
            {title ? <h2 className={styles.title}>{title}</h2> : null}
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}
