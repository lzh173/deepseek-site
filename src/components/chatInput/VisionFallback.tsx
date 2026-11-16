import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useUploads } from '../../services/attachments.js'
import {
  EMPTY_DRAFT,
  getDraft,
  setDraftText,
  useDrafts,
  type DraftAttachment,
} from '../../services/chat/drafts.js'
import { loadModels, useCurrentModel, useModels } from '../../services/models.js'
import { setModel } from '../../services/settings.js'
import { describeImage } from '../../services/vision.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './VisionFallback.module.css'

/**
 * 多模态降级提示条（GOAL.md §10）：草稿里有图片、而当前模型的 caps.vision 为 false 时，
 * 在输入框上方给两条出路——换一个能看图的模型，或让视觉模型先把图片转述成文字。
 *
 * 只是提示，不拦发送：用户不理会直接发送时，后端仍按现状把图片替换成附件占位。
 * 转述结果以「\n\n[图片转述] …」的形式追加到草稿末尾，用户可以先改了再发。
 */
export const VisionFallback = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  // 只订阅附件列表：输入文字变化不重建提示条（drafts 更新时 attachments 引用保持不变）
  const attachments = useDrafts((state) => (state.drafts.get(sessionId) ?? EMPTY_DRAFT).attachments)
  // 上传完成态：图片还在上传时拿不到 serverId（file_id），转述按钮先禁用
  const tasks = useUploads((state) => state.tasks)
  const current = useCurrentModel()
  const [describing, setDescribing] = useState(false)
  const [switching, setSwitching] = useState(false)

  const images = attachments.filter((item) => item.isImage)
  // 模型列表未就绪（current 为 null）时按「未知」处理，不显示提示
  if (images.length === 0 || current === null || current.caps.vision !== false) {
    return null
  }

  /** 已上传成功才有 file_id；排队 / 上传中 / 上传失败都先跳过 */
  const fileIds = images.flatMap((item: DraftAttachment) => {
    const task = tasks[item.id]
    return task?.status === 'done' ? [task.serverId] : []
  })
  // 与发送按钮同一规则：全部附件上传成功才动，避免只转述了一部分图片
  const ready = fileIds.length === images.length

  /** 换一个能看图的模型：优先当前可用的，直接写进已有的模型设置 */
  const switchModel = async (): Promise<void> => {
    if (switching || describing) {
      return
    }
    setSwitching(true)
    try {
      // 列表通常登录后就拉好了；为空时补拉一次再挑，避免误报「没有可用模型」
      if (useModels.getState().models.length === 0) {
        await loadModels()
      }
      const target = useModels.getState().models.find((item) => item.caps.vision && item.available)
      if (!target) {
        showToast({ key: 'visionNoModelAvailable', type: 'error' })
        return
      }
      setModel(target.id)
      showToast({ key: 'visionModelSwitched', params: { model: target.display_name } })
    } finally {
      setSwitching(false)
    }
  }

  /** 逐张转述，拼成一段文本追加到输入框末尾；失败时把后端 message（含 ray）交给 toast */
  const describe = async (): Promise<void> => {
    if (describing || switching || !ready || fileIds.length === 0) {
      return
    }
    setDescribing(true)
    try {
      const results = await Promise.all(fileIds.map((fileId) => describeImage(fileId)))
      const marker = t('visionTranscriptMarker')
      const block = results.map((result) => `${marker} ${result.description}`).join('\n\n')
      const text = getDraft(sessionId).text
      setDraftText(sessionId, text === '' ? block : `${text}\n\n${block}`)
      showToast({ key: 'visionTranscriptAttached' })
    } catch (error) {
      showToast({
        type: 'error',
        key: 'visionDescribeFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      setDescribing(false)
    }
  }

  return (
    <div className={styles.banner} role="note">
      <div className={styles.text}>
        <div className={styles.title}>
          {t('visionUnsupportedModel', { model: current.display_name })}
        </div>
        <div className={styles.description}>{t('visionFallbackDescription')}</div>
      </div>
      <div className={styles.actions} aria-busy={describing}>
        <Button
          variant="outlined"
          size="s"
          disabled={describing || switching}
          onClick={() => void switchModel()}
        >
          {t('visionSwitchModel')}
        </Button>
        <Button
          variant="primary"
          size="s"
          disabled={describing || switching || !ready}
          onClick={() => void describe()}
        >
          {t(describing ? 'visionDescribing' : 'visionDescribeAction')}
        </Button>
      </div>
    </div>
  )
}
