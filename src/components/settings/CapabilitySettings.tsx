import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { apiUrl, request } from '../../services/api/client.js'
import { currentCapabilities } from '../../services/capabilities.js'
import { loadCapPrefs, setCapPref, useCapPrefs, type CapKey, type CapSource } from '../../services/capPrefs.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'
import cap from './CapabilitySettings.module.css'

/**
 * 「能力与账号」分区。
 *
 * 每项能力一行：左边名字 + 说明，右边是「来源」下拉，最后是当前生效状态徽标。
 * - 官方：管理员与授权账号可选（按次计费，质量最好）
 * - 浏览器：TTS/ASR 可用（免费，质量一般）
 * - 关闭：search/fetch/ocr/document 可以彻底关掉
 * 免费账号只有「浏览器 / 关闭」两档，下拉里不会出现「官方」。
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

/** 哪些能力有浏览器实现（决定下拉里是否出现「浏览器」） */
const HAS_BROWSER: CapabilityKey[] = ['tts', 'asr']

const toCapKey = (key: CapabilityKey): CapKey => key as CapKey

export const CapabilitySettings = () => {
  const t = useTranslate()
  const matrix = currentCapabilities()
  const prefs = useCapPrefs((state) => state.prefs)
  const saved = useCapPrefs((state) => state.loaded)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!saved) {
      void loadCapPrefs()
    }
  }, [saved])

  const optionsFor = (key: CapabilityKey): { value: CapSource; label: string }[] => {
    const list: { value: CapSource; label: string }[] = [
      { value: 'auto', label: t('settingsCapSourceAuto') },
    ]
    if (matrix?.official[key] === true) {
      list.push({ value: 'server', label: t('settingsCapSourceServer') })
    }
    if (HAS_BROWSER.includes(key)) {
      list.push({ value: 'browser', label: t('settingsCapSourceBrowser') })
    }
    list.push({ value: 'off', label: t('settingsCapSourceOff') })
    return list
  }

  const onChange = async (key: CapabilityKey, value: CapSource) => {
    try {
      await setCapPref(toCapKey(key), value)
      showToast({ key: 'settingsCapPrefSaved' })
    } catch (error) {
      showToast({ type: 'error', key: 'settingsCapOcrFailed', params: { message: String(error) } })
    }
  }

  const effective = (key: CapabilityKey): 'server' | 'browser' | 'off' => {
    const pref = prefs[toCapKey(key)]
    if (pref === 'off') {
      return 'off'
    }
    if (pref === 'browser') {
      return 'browser'
    }
    if (pref === 'server') {
      return matrix?.official[key] === true ? 'server' : 'off'
    }
    return matrix?.official[key] === true ? 'server' : HAS_BROWSER.includes(key) ? 'browser' : 'off'
  }

  const runOcr = async (file: File) => {
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
        // 剪贴板不可用：结果仍通过 toast 提示页数
      }
      showToast({ key: 'settingsCapOcrDone', params: { pages: String(body.pages ?? 1) } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast({ type: 'error', key: 'settingsCapOcrFailed', params: { message } })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsCapabilities')}</div>
          <div className={styles.description}>{t('settingsCapabilitiesHint')}</div>
        </div>
      </div>

      {ROWS.map((row) => {
        const current = effective(row.key)
        return (
          <div key={row.key} className={clsx(styles.cell, styles.row)}>
            <div className={styles.text}>
              <div className={styles.label}>{t(row.label)}</div>
            </div>
            <Select
              ariaLabel={t(row.label)}
              value={prefs[toCapKey(row.key)]}
              options={optionsFor(row.key)}
              onChange={(value) => void onChange(row.key, value)}
            />
            <span
              className={clsx(
                cap.badge,
                current === 'server' ? cap.on : current === 'browser' ? cap.browser : cap.off
              )}
            >
              {current === 'server'
                ? t('settingsCapOnServer')
                : current === 'browser'
                  ? t('settingsCapOnBrowser')
                  : t('settingsCapOff')}
            </span>
          </div>
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
          disabled={busy || effective('ocr') !== 'server'}
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
