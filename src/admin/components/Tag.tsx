import clsx from 'clsx'
import type { ReactNode } from 'react'
import styles from './Tag.module.css'

/**
 * 状态/属性小标签。
 * tone 只决定前景与底色，底色同样取自 theme.css（亮/暗两套由变量切换）。
 */
export type TagTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'muted'

export const Tag = ({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: TagTone
  children: ReactNode
  className?: string
  title?: string
}) => (
  <span className={clsx(styles.tag, styles[tone], className)} title={title}>
    {children}
  </span>
)
