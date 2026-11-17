import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { isSpeechUnsupported, probeTranscribe, transcribe } from '../../services/api/speech.js'
import { useSettings } from '../../services/settings.js'
import { shouldUseServer } from '../../services/capPrefs.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/**
 * 服务端 ASR 是否可用，模块级缓存：
 * MVP 阶段（GOAL.md A-08）BFF 返回 404 / 501，探测到一次之后整个会话都不再请求，
 * 直接走浏览器实时识别，不必每次点击都先失败一次。
 */
type AsrBackend = 'unknown' | 'available' | 'unsupported'

const useAsrBackend = create<{ backend: AsrBackend }>(() => ({ backend: 'unknown' }))

/**
 * 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://）。
 * 普通 HTTP 页面上直接禁用入口，避免点击后必然失败。
 */
const SECURE_CONTEXT = typeof window === 'undefined' || window.isSecureContext

/** 浏览器实时识别：Chrome / Edge 用标准名，Safari 只暴露 webkit 前缀 */
const getRecognition = (): SpeechRecognitionConstructor | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

const BROWSER_ASR = getRecognition() !== null

/** 入口不可用的原因，按钮据此换禁用文案 */
export type VoiceUnavailableReason = 'insecure' | 'unsupported'

const unavailableReason = (backend: AsrBackend): VoiceUnavailableReason | null => {
  if (!SECURE_CONTEXT) {
    return 'insecure'
  }
  return backend === 'unsupported' && !BROWSER_ASR ? 'unsupported' : null
}

/** 当前走哪条识别链路：服务端未实现且浏览器支持时用浏览器识别 */
export const useVoiceMode = (): 'server' | 'browser' =>
  useAsrBackend((state) => state.backend) === 'unsupported' && BROWSER_ASR ? 'browser' : 'server'

/** 入口不可用的原因，供按钮把「需要 HTTPS」与「浏览器不支持」区分开 */
export const useVoiceUnavailableReason = (): VoiceUnavailableReason | null =>
  unavailableReason(useAsrBackend((state) => state.backend))

const describeRecordingError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

/** 浏览器识别的错误码映射到既有提示键；null 与 aborted 表示用户主动结束，不提示 */
const describeBrowserAsrError = (
  error: SpeechRecognitionErrorCode | null
): TranslationMessage | null => {
  switch (error) {
    case null:
    case 'aborted':
      return null
    case 'not-allowed':
    case 'service-not-allowed':
      return { key: 'voiceInputPermissionDenied' }
    case 'audio-capture':
      return { key: 'voiceInputNoDevice' }
    case 'no-speech':
      return { key: 'voiceInputEmpty' }
    default:
      return { key: 'voiceInputFailed' }
  }
}

type BrowserAsrResult = { text: string; error: SpeechRecognitionErrorCode | null }

type BrowserAsrSession = {
  /** 结束识别；最终文本由 onFinish 统一给出 */
  stop: () => void
  /** 放弃本次识别，不再回调 */
  cancel: () => void
}

/**
 * 浏览器实时识别（Web Speech）：start 之后一直听，直到再次点击或浏览器自己结束
 * （静默、权限被拒、断网都会让浏览器提前结束，此时把已识别到的文本照常交出去）。
 * 只拼接 isFinal 的结果，中间结果不用，避免输入框反复变动。
 */
const startBrowserAsr = (
  onFinish: (result: BrowserAsrResult) => void
): BrowserAsrSession | null => {
  const Recognition = getRecognition()
  if (!Recognition) {
    return null
  }
  const recognition = new Recognition()
  // 识别语言跟随界面语言，浏览器会在本机语音服务里找最接近的
  recognition.lang = useSettings.getState().locale
  // 持续识别：由用户点击结束，而不是说完一句就停
  recognition.continuous = true
  recognition.interimResults = false
  recognition.maxAlternatives = 1

  let text = ''
  let error: SpeechRecognitionErrorCode | null = null
  let settled = false
  let cancelled = false
  let stopping = false

  const settle = () => {
    if (settled || cancelled) {
      return
    }
    settled = true
    onFinish({ text, error })
  }

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result?.isFinal) {
        text += result[0]?.transcript ?? ''
      }
    }
  }
  recognition.onerror = (event) => {
    error = event.error
  }
  recognition.onend = settle

  try {
    recognition.start()
  } catch {
    return null
  }

  return {
    stop: () => {
      if (stopping) {
        return
      }
      stopping = true
      try {
        recognition.stop()
      } catch {
        settle()
        return
      }
      // 个别浏览器 stop() 之后不再派发 onend，兜一层超时，别让状态卡在录音中
      window.setTimeout(settle, 2000)
    },
    cancel: () => {
      cancelled = true
      try {
        recognition.abort()
      } catch {
        // 已经结束，无需处理
      }
    },
  }
}

/**
 * 语音输入（oneshot）：点击开始，再次点击结束，结果交给 onText 填入输入框。
 * - 服务端 ASR 可用：录音 → 上传转写（原有流程），转写中再次点击取消，录满 120 秒自动结束。
 * - 服务端未实现（404 / 501）：浏览器支持 Web Speech 时改用实时识别，status 仍复用 recording。
 * - 两者都不可用：available 为 false，入口禁用。
 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const backend = useAsrBackend((state) => state.backend)
  const recordingRef = useRef<Recording | null>(null)
  const browserRef = useRef<BrowserAsrSession | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const operationRef = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(() => {
    operationRef.current++
    recordingRef.current?.cancel()
    recordingRef.current = null
    browserRef.current?.cancel()
    browserRef.current = null
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const cancel = useCallback(() => {
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  /** 启动浏览器实时识别；结束（点击或浏览器自己结束）统一在回调里收尾 */
  const startBrowserSession = useCallback((operation: number) => {
    const session = startBrowserAsr((result) => {
      if (operationRef.current !== operation) {
        return
      }
      browserRef.current = null
      setStatus('idle')
      const message = describeBrowserAsrError(result.error)
      if (message) {
        showToast(message)
        return
      }
      const transcript = result.text.trim()
      if (transcript) {
        onTextRef.current(transcript)
      } else {
        showToast({ key: 'voiceInputEmpty' })
      }
    })
    if (!session) {
      setStatus('idle')
      showToast({ key: 'voiceInputFailed' })
      return
    }
    if (operationRef.current !== operation) {
      session.cancel()
      return
    }
    browserRef.current = session
    setStatus('recording')
  }, [])

  const finish = useCallback(async () => {
    const browser = browserRef.current
    if (browser) {
      // 浏览器识别：结束动作很轻，文本由 onend 回调交给 onText
      browser.stop()
      return
    }
    const recording = recordingRef.current
    if (!recording) {
      // 仍在等待麦克风授权（或服务端探测）时也允许取消；迟到的结果会被丢弃。
      cancel()
      return
    }
    const operation = operationRef.current
    recordingRef.current = null
    let controller: AbortController | null = null
    /** 服务端未实现：本次失败后改走浏览器识别 */
    let unsupported = false
    try {
      let audio: Blob | null
      try {
        audio = await recording.stop()
      } finally {
        recording.cancel()
      }
      if (operationRef.current !== operation || !audio) {
        return
      }
      controller = new AbortController()
      controllerRef.current = controller
      setStatus('transcribing')
      const text = await transcribe(audio, controller.signal)
      if (controller.signal.aborted || operationRef.current !== operation) {
        return
      }
      if (text.trim()) {
        onTextRef.current(text.trim())
      } else {
        showToast({ key: 'voiceInputEmpty' })
      }
    } catch (error) {
      if (operationRef.current === operation && !controller?.signal.aborted) {
        if (isSpeechUnsupported(error)) {
          // 探测时还可用、真正上传时已经不在了：记下来，本次与以后都走浏览器识别
          useAsrBackend.setState({ backend: 'unsupported' })
          unsupported = true
        } else {
          showToast({ key: 'voiceInputFailed' })
        }
      }
    } finally {
      if (operationRef.current === operation) {
        controllerRef.current = null
        if (!unsupported) {
          setStatus('idle')
        }
      }
    }
    if (unsupported && operationRef.current === operation) {
      if (BROWSER_ASR) {
        showToast({ key: 'voiceInputSwitchToBrowser' })
        startBrowserSession(operation)
      } else {
        setStatus('idle')
        showToast({ key: 'voiceInputUnsupported' })
      }
    }
  }, [cancel, startBrowserSession])

  const toggle = useCallback(async () => {
    if (unavailableReason(useAsrBackend.getState().backend) !== null) {
      return
    }
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    const operation = ++operationRef.current
    // 与原有流程一致：先进入录音态，麦克风授权或服务端探测期间也能点击取消
    setStatus('recording')
    let { backend: current } = useAsrBackend.getState()
    if (current === 'unknown') {
      // 设置里选了「浏览器」就直接走本地识别，不再探服务端（省一次往返）
      const supported = shouldUseServer('asr') ? await probeTranscribe() : false
      if (operationRef.current !== operation) {
        return
      }
      if (supported !== null) {
        current = supported ? 'available' : 'unsupported'
        useAsrBackend.setState({ backend: current })
      }
    }
    if (current === 'unsupported') {
      if (BROWSER_ASR) {
        startBrowserSession(operation)
      } else {
        setStatus('idle')
        showToast({ key: 'voiceInputUnsupported' })
      }
      return
    }
    try {
      const recording = await startRecording(() => {
        if (operationRef.current === operation) {
          showToast({ key: 'voiceInputLimitReached' })
          void finish()
        }
      })
      if (operationRef.current !== operation) {
        recording.cancel()
        return
      }
      recordingRef.current = recording
    } catch (error) {
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast(describeRecordingError(error))
      }
    }
  }, [status, finish, cancel, startBrowserSession])

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])

  /** 当前录音的频谱分析节点；浏览器识别没有音频流，返回 null */
  const getAnalyser = useCallback(() => recordingRef.current?.analyser ?? null, [])

  return {
    status,
    seconds,
    getAnalyser,
    toggle,
    cancel,
    available: unavailableReason(backend) === null,
  }
}
