import type { ReactNode } from 'react'
import { Button } from '../../components/base/Button.js'
import { copy } from '../copy.js'
import styles from './EmptyState.module.css'

/** 空状态的统一外观：标题 + 一句该做什么 + 可选操作 */
export const EmptyState = ({
  title = copy.common.empty,
  hint,
  action,
}: {
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
}) => (
  <div className={styles.state}>
    <div className={styles.title}>{title}</div>
    {hint ? <div className={styles.hint}>{hint}</div> : null}
    {action ? <div className={styles.action}>{action}</div> : null}
  </div>
)

/** 请求失败：直接展示后端 message（自带 ray），并给一个重试入口 */
export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className={styles.state} role="alert">
    <div className={styles.errorTitle}>{message}</div>
    {onRetry ? (
      <div className={styles.action}>
        <Button variant="outlined" size="s" onClick={onRetry}>
          {copy.common.retry}
        </Button>
      </div>
    ) : null}
  </div>
)
