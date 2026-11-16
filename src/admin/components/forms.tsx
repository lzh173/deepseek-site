import clsx from 'clsx'
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import styles from './forms.module.css'

/** 表单字段：标签在上面，说明/错误在下面；控件由调用方给 */
export const Field = ({
  label,
  hint,
  error,
  wide = false,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** 在 FormGrid 里占满一行 */
  wide?: boolean
  children: ReactNode
}) => (
  <div className={clsx(styles.field, wide && styles.wide)}>
    <div className={styles.label}>{label}</div>
    {children}
    {error ? (
      <div className={styles.error}>{error}</div>
    ) : hint ? (
      <div className={styles.hint}>{hint}</div>
    ) : null}
  </div>
)

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={clsx(styles.input, className)} {...props} />
)

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={clsx(styles.textarea, className)} {...props} />
)

/** 开关：视觉上用轨道 + 圆点，行为仍然是 checkbox，键盘可操作 */
export const Switch = ({
  checked,
  onChange,
  disabled = false,
  label,
  id,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: ReactNode
  id?: string
}) => (
  <label className={clsx(styles.switch, disabled && styles.switchDisabled)}>
    <input
      id={id}
      className={styles.switchInput}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
    <span className={styles.track}>
      <span className={styles.thumb} />
    </span>
    {label ? <span className={styles.switchLabel}>{label}</span> : null}
  </label>
)

/** 两列网格表单；列数为 1 时用于窄面板 */
export const FormGrid = ({
  columns = 2,
  children,
}: {
  columns?: 1 | 2
  children: ReactNode
}) => (
  <div className={styles.grid} data-columns={columns}>
    {children}
  </div>
)
