import { useCallback, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { apiUrl, request } from '../../services/api/client.js'
import { currentCapabilities } from '../../services/capabilities.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'
import cap from './CapabilitySettings.module.css'

/**
 * 「能力与账号」分区：把账号层级与官方能力可用性摆出来，并提供 OCR 自测。
 *
 * 三档账号的差异在这里是可见的，用户不会因为「点了没反应」而困惑：
 * - 管理员：官方能力全绿
 * - 授权账号：同样全绿（后端按 grants 判定）
 * - 免费账号：显示「浏览器」，说明走的是本地兜底
 */

type Matrix = NonNullable<ReturnType<typeof currentCapabilities>>
type CapabilityKey = keyof Matrix['official']

const ROWS: { key: CapabilityKey; label: 'settingsCapSearch' | 'settingsCapFetch' | 'settingsCapTts' | 'settingsCapAsr' | 'settingsCapOcr' | 'settingsCapDocument' }[] = [
  { key: 'search', label: 'settingsCapSearch' },
  { key: 'fetch', label: 'settingsCapFetch' },
  { key: 'tts', label: 'settingsCapTts' },
  { key: 'asr', label: 'settingsCapAsr' },
  { key: 'ocr', label: 'settingsCapOcr' },
  { key: 'document', label: 'settingsCapDocument' },
]

/** 这些能力即便没有官方实现，浏览器/本地也能兜住 */
const BROWSER_FALLBACK: CapabilityKey[] = ['tts', 'asr', 'ocr', 'document']

const Row = ({
  label,
  hint,
  badge,
  badgeTone,
  action,
}: {
  label: string
  hint?: string
  badge: string
  badgeTone: 'on' | 'off' | 'browser'
  action?: React.ReactNode
}) => (
  <div className={clsx(styles.cell, styles.row)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {hint ? <div className={styles.description}>{hint}</div> : null}
    </div>
    {action ?? null}
    <span className={clsx(cap.badge, cap[badgeTone])}>{badge}</span>
  </div>
)

export const CapabilitySettings = () => {
  const t = useTranslate()
  const matrix = currentCapabilities()
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const runOcr = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await request(apiUrl('/ocr'), { method: 'POST', body: form })
      const body = (await response.json()) as { text?: string; pages?: number }
      const text = body.text ?? ''
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // 剪贴板不可用：结果只留在 toast 里，不再额外打日志
      }
      showToast({ key: 'settingsCapOcrDone', params: { pages: String(body.pages ?? 1) } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast({ type: 'error', key: 'settingsCapOcrFailed', params: { message } })
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsCapabilities')}</div>
          <div className={styles.description}>{t('settingsCapabilitiesHint')}</div>
        </div>
        <span className={clsx(cap.badge, cap.tier)}>
          {matrix?.tier === 'admin' ? t('settingsCapTierAdmin') : t('settingsCapTierUser')}
        </span>
      </div>

      {ROWS.map((row) => {
        const official = matrix?.official[row.key] === true
        const fallback = BROWSER_FALLBACK.includes(row.key)
        return (
          <Row
            key={row.key}
            label={t(row.label)}
            badge={
              official
                ? t('settingsCapOnServer')
                : fallback
                  ? t('settingsCapOnBrowser')
                  : t('settingsCapOff')
            }
            badgeTone={official ? 'on' : fallback ? 'browser' : 'off'}
          />
        )
      })}

      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsCapOcrAction')}</div>
          <div className={styles.description}>{t('settingsCapOcrPicking')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          disabled={busy || matrix?.official.ocr !== true}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? t('settingsCapOcrRunning') : t('settingsCapOcrAction')}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        hidden
        accept=".pdf,.doc,.docx,.ppt,.pptx,image/*"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) {
            void runOcr(file)
          }
        }}
      />
    </>
  )
}
