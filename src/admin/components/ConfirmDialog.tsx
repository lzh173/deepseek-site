import type { ReactNode } from 'react'
import { Button } from '../../components/base/Button.js'
import { Modal } from '../../components/base/Modal.js'
import { copy } from '../copy.js'

/**
 * 破坏性操作的二次确认。
 * busy 期间不允许关闭，避免请求还在飞就把弹窗点没了。
 */
export const ConfirmDialog = ({
  title,
  description,
  confirmLabel = copy.common.delete,
  pendingLabel = copy.common.deleting,
  danger = true,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: ReactNode
  description: ReactNode
  confirmLabel?: string
  pendingLabel?: string
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) => (
  <Modal
    title={title}
    onClose={() => {
      if (!busy) {
        onCancel()
      }
    }}
    footer={
      <>
        <Button variant="outlined" autoFocus disabled={busy} onClick={onCancel}>
          {copy.common.cancel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
          {busy ? pendingLabel : confirmLabel}
        </Button>
      </>
    }
  >
    {description}
  </Modal>
)
