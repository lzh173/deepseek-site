import clsx from 'clsx'
import type { CSSProperties } from 'react'
import styles from './Skeleton.module.css'

/** 加载占位块：用 theme.css 的 skeleton 底色，不闪白 */
export const Skeleton = ({
  width = '100%',
  height = 14,
  className,
  style,
}: {
  width?: string | number
  height?: string | number
  className?: string
  style?: CSSProperties
}) => (
  <span
    className={clsx(styles.skeleton, className)}
    style={{ width, height, ...style }}
    aria-hidden="true"
  />
)
