/** 管理端的展示格式化工具：时间、字节、数字、耗时。全部按本机时区展示。 */

import { copy } from './copy.js'

const pad = (value: number): string => String(value).padStart(2, '0')

/** ISO 时间 → 本机 "YYYY-MM-DD HH:mm:ss"；空值或非法值返回占位符 */
export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) {
    return '—'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** ISO 时间 → 本机 "MM-DD HH:mm"，用于表格里节省宽度 */
export const formatShortDateTime = (iso: string | null | undefined): string => {
  if (!iso) {
    return '—'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** ISO 时间 → <input type="datetime-local"> 需要的本机时间串 */
export const toLocalInput = (iso: string | null | undefined): string => {
  if (!iso) {
    return ''
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** <input type="datetime-local"> 的值 → UTC ISO；空串表示"永久" */
export const fromLocalInput = (value: string): string | null => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 今天 00:00（本机）对应的 UTC ISO，用于日志的 from 过滤 */
export const startOfTodayIso = (): string => {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.toISOString()
}

/** 字节 → 人类可读；保留一位小数，整数位超过 100 时取整 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** 毫秒 → 人类可读；超过 1 秒用秒表示 */
export const formatDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) {
    return '—'
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/** 千分位数字 */
export const formatNumber = (value: number | null | undefined): string => {
  if (value === null || value === undefined) {
    return '—'
  }
  return value.toLocaleString('zh-CN')
}

/** 0–1 的比例 → "12.3%" */
export const formatPercent = (ratio: number): string => {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return '0%'
  }
  const percent = ratio * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
}

/** token 数 → "1.2K" 之类的紧凑写法；表格里用 */
export const formatCompact = (value: number | null | undefined): string => {
  if (value === null || value === undefined) {
    return '—'
  }
  if (value < 1000) {
    return String(value)
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`
  }
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 上下文长度 → "32K" */
export const formatContext = (tokens: number): string =>
  tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens)

/** 冷却剩余时间 → "还剩 3 分 12 秒"；已到期返回空串 */
export const formatRemaining = (iso: string | null | undefined, now: number): string => {
  if (!iso) {
    return ''
  }
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) {
    return ''
  }
  const seconds = Math.max(0, Math.round((target - now) / 1000))
  if (seconds <= 0) {
    return ''
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes <= 0) {
    return copy.common.duration.seconds(seconds)
  }
  const hours = Math.floor(minutes / 60)
  if (hours <= 0) {
    return copy.common.duration.minutes(minutes, seconds % 60)
  }
  return copy.common.duration.hours(hours, minutes % 60)
}
