import { create } from 'zustand'
import { apiUrl, request } from './api/client.js'
import { currentCapabilities } from './capabilities.js'

/**
 * 能力来源偏好：让用户在设置里显式选择每项能力走「官方」还是「浏览器」。
 *
 * 官方能力按次计费，浏览器实现免费但质量有差距；把选择权交给用户，
 * 免费账号则只有浏览器可选（后端 official.* 全 false）。
 */
export type CapSource = 'auto' | 'server' | 'browser' | 'off'

export type CapPrefs = {
  search: CapSource
  fetch: CapSource
  tts: CapSource
  asr: CapSource
  ocr: CapSource
  document: CapSource
}

export type CapKey = keyof CapPrefs

const DEFAULTS: CapPrefs = {
  search: 'auto',
  fetch: 'auto',
  tts: 'auto',
  asr: 'auto',
  ocr: 'auto',
  document: 'auto',
}

type PrefsState = {
  prefs: CapPrefs
  loaded: boolean
  saving: boolean
}

export const useCapPrefs = create<PrefsState>(() => ({
  prefs: { ...DEFAULTS },
  loaded: false,
  saving: false,
}))

export const loadCapPrefs = async (): Promise<void> => {
  try {
    const response = await request(apiUrl('/capabilities/prefs'), {})
    const body = (await response.json()) as { prefs?: Partial<CapPrefs> }
    useCapPrefs.setState({ prefs: { ...DEFAULTS, ...body.prefs }, loaded: true })
  } catch {
    useCapPrefs.setState({ loaded: true })
  }
}

export const setCapPref = async (key: CapKey, value: CapSource): Promise<void> => {
  const previous = useCapPrefs.getState().prefs
  useCapPrefs.setState({ prefs: { ...previous, [key]: value }, saving: true })
  try {
    const response = await request(apiUrl('/capabilities/prefs'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
    const body = (await response.json()) as { prefs?: Partial<CapPrefs> }
    useCapPrefs.setState({ prefs: { ...DEFAULTS, ...body.prefs } })
  } catch {
    // 保存失败回滚，避免界面与服务端不一致
    useCapPrefs.setState({ prefs: previous })
    throw new Error('保存能力偏好失败')
  } finally {
    useCapPrefs.setState({ saving: false })
  }
}

export const resetCapPrefs = (): void => {
  useCapPrefs.setState({ prefs: { ...DEFAULTS }, loaded: false })
}

/** 某项能力当前是否应当走服务端（官方） */
export const shouldUseServer = (key: CapKey): boolean => {
  const pref = useCapPrefs.getState().prefs[key]
  if (pref === 'browser' || pref === 'off') {
    return false
  }
  if (pref === 'server') {
    return true
  }
  // auto：有官方能力就走官方
  return currentCapabilities()?.official[key] === true
}
