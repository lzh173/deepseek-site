import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { IconButton } from '../../components/base/IconButton.js'
import { IconTrashOutline16 } from '../../components/base/icons.js'
import { Modal } from '../../components/base/Modal.js'
import { Select } from '../../components/base/Select.js'
import { showToast } from '../../components/base/toastState.js'
import {
  api,
  errorMessage,
  type Channel,
  type ChannelInput,
  type ChannelKind,
  type ProbeResult,
  type Tier,
} from '../api.js'
import { Card } from '../components/Card.js'
import { DataTable, type DataTableColumn } from '../components/DataTable.js'
import { ErrorState } from '../components/EmptyState.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { Field, FormGrid, Input, Switch } from '../components/forms.js'
import { PageHeader } from '../components/PageHeader.js'
import { Tag } from '../components/Tag.js'
import { copy } from '../copy.js'
import ui from '../components/ui.module.css'
import styles from './Channels.module.css'

type Draft = {
  name: string
  kind: ChannelKind
  base_url: string
  tier: Tier
  priority: string
  /** 界面用秒，提交时换算成毫秒 */
  timeout: string
  concurrency: string
  enabled: boolean
}

type DraftErrors = Partial<Record<keyof Draft, string>>

const kindOptions: { value: ChannelKind; label: string }[] = [
  { value: 'openai', label: copy.channels.kindLabels.openai },
  { value: 'anthropic', label: copy.channels.kindLabels.anthropic },
  { value: 'gemini', label: copy.channels.kindLabels.gemini },
  { value: 'ollama', label: copy.channels.kindLabels.ollama },
]

const tierOptions: { value: Tier; label: string }[] = [
  { value: 'free', label: copy.channels.tierFree },
  { value: 'paid', label: copy.channels.tierPaid },
]

const emptyDraft = (): Draft => ({
  name: '',
  kind: 'openai',
  base_url: '',
  tier: 'free',
  priority: '100',
  timeout: '120',
  concurrency: '4',
  enabled: true,
})

const draftOf = (channel: Channel): Draft => ({
  name: channel.name,
  kind: channel.kind,
  base_url: channel.base_url,
  tier: channel.tier,
  priority: String(channel.priority),
  timeout: String(Math.round(channel.timeout_ms / 1000)),
  concurrency: String(channel.concurrency),
  enabled: channel.enabled,
})

const isInteger = (value: string, min: number): boolean => {
  const text = value.trim()
  return /^\d+$/.test(text) && Number(text) >= min
}

const validate = (draft: Draft): DraftErrors => {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) {
    errors.name = copy.common.validation.required
  }
  if (!/^https?:\/\/\S+$/i.test(draft.base_url.trim())) {
    errors.base_url = copy.common.validation.url
  }
  if (!isInteger(draft.priority, 0)) {
    errors.priority = copy.common.validation.number
  }
  if (!isInteger(draft.timeout, 1)) {
    errors.timeout = copy.common.validation.number
  }
  if (!isInteger(draft.concurrency, 1)) {
    errors.concurrency = copy.common.validation.number
  }
  return errors
}

/** 探活结果：成功显示延迟与状态码，失败显示原因 */
const ProbeCell = ({ probe, testing }: { probe?: ProbeResult; testing: boolean }) => {
  if (testing) {
    return <Tag tone="neutral">{copy.channels.testing}</Tag>
  }
  if (!probe) {
    return <span className={ui.muted}>{copy.common.none}</span>
  }
  if (probe.ok) {
    return <Tag tone="success">{copy.channels.probeOk(probe.latency_ms, probe.status ?? 0)}</Tag>
  }
  return (
    <Tag tone="danger" className={styles.probeTag} title={probe.error ?? ''}>
      {probe.error
        ? copy.channels.probeError(probe.error)
        : copy.channels.probeFailed(probe.latency_ms)}
    </Tag>
  )
}

/** 渠道页：增删改 + 连通性测试 + 启停 */
export const Channels = () => {
  const [items, setItems] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<{ channel: Channel | null } | null>(null)
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [testingId, setTestingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.channels.list()
      setItems(result.items)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runTest = async (channel: Channel) => {
    setTestingId(channel.id)
    try {
      const result = await api.channels.test(channel.id)
      setProbes((prev) => ({ ...prev, [channel.id]: result }))
      if (!result.ok) {
        showToast(result.error ?? copy.channels.probeFailed(result.latency_ms))
      }
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setTestingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) {
      return
    }
    setDeletePending(true)
    try {
      await api.channels.remove(deleting.id)
      showToast(copy.channels.deleted)
      setDeleting(null)
      await load()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setDeletePending(false)
    }
  }

  const columns: DataTableColumn<Channel>[] = [
    {
      key: 'name',
      title: copy.channels.columns.name,
      width: '196px',
      render: (row) => (
        <div className={styles.nameCell}>
          <span className={ui.ellipsis}>{row.name}</span>
          <Tag tone="neutral">{copy.channels.kindLabels[row.kind]}</Tag>
        </div>
      ),
    },
    {
      key: 'baseUrl',
      title: copy.channels.columns.baseUrl,
      width: '236px',
      render: (row) => (
        <span className={ui.code} title={row.base_url}>
          {row.base_url}
        </span>
      ),
    },
    {
      key: 'tier',
      title: copy.channels.columns.tier,
      width: '76px',
      render: (row) => (
        <Tag tone={row.tier === 'paid' ? 'brand' : 'neutral'}>
          {row.tier === 'paid' ? copy.channels.tierPaid : copy.channels.tierFree}
        </Tag>
      ),
    },
    {
      key: 'priority',
      title: copy.channels.columns.priority,
      width: '72px',
      render: (row) => <span className={ui.mono}>{row.priority}</span>,
    },
    {
      key: 'timeout',
      title: copy.channels.columns.timeout,
      width: '72px',
      render: (row) => <span className={ui.mono}>{Math.round(row.timeout_ms / 1000)} s</span>,
    },
    {
      key: 'concurrency',
      title: copy.channels.columns.concurrency,
      width: '64px',
      render: (row) => <span className={ui.mono}>{row.concurrency}</span>,
    },
    {
      key: 'keyCount',
      title: copy.channels.columns.keyCount,
      width: '72px',
      render: (row) => <span className={ui.mono}>{row.key_count}</span>,
    },
    {
      key: 'status',
      title: copy.channels.columns.status,
      width: '76px',
      render: (row) => (
        <Tag tone={row.enabled ? 'success' : 'muted'}>
          {row.enabled ? copy.common.enabled : copy.common.disabled}
        </Tag>
      ),
    },
    {
      key: 'probe',
      title: copy.channels.columns.probe,
      width: '170px',
      render: (row) => <ProbeCell probe={probes[row.id]} testing={testingId === row.id} />,
    },
    {
      key: 'actions',
      title: copy.common.actions,
      align: 'end',
      width: '196px',
      render: (row) => (
        <div className={ui.rowEnd} onClick={(event) => event.stopPropagation()}>
          <Button
            variant="outlined"
            size="s"
            disabled={testingId === row.id}
            onClick={() => void runTest(row)}
          >
            {copy.channels.test}
          </Button>
          <Button variant="outlined" size="s" onClick={() => setModal({ channel: row })}>
            {copy.common.edit}
          </Button>
          <IconButton
            icon={<IconTrashOutline16 />}
            tooltip={copy.common.delete}
            onClick={() => setDeleting(row)}
          />
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title={copy.channels.title}
        description={copy.channels.description}
        actions={
          <>
            <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
              {copy.common.refresh}
            </Button>
            <Button size="m" onClick={() => setModal({ channel: null })}>
              {copy.channels.create}
            </Button>
          </>
        }
      />

      <Card flush>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (
          <DataTable
            className={styles.table}
            columns={columns}
            rows={items}
            rowKey={(row) => row.id}
            loading={loading}
            skeletonRows={5}
            emptyTitle={copy.channels.empty}
            emptyHint={copy.channels.emptyHint}
            emptyAction={
              <Button size="s" onClick={() => setModal({ channel: null })}>
                {copy.channels.create}
              </Button>
            }
          />
        )}
      </Card>

      {modal ? (
        <ChannelForm
          channel={modal.channel}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            void load()
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={copy.channels.deleteTitle}
          description={copy.channels.deleteDescription(deleting.name, deleting.key_count)}
          busy={deletePending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  )
}

/** 新建/编辑共用一个表单；id 由服务端生成，不在这里出现 */
const ChannelForm = ({
  channel,
  onClose,
  onSaved,
}: {
  channel: Channel | null
  onClose: () => void
  onSaved: () => void
}) => {
  const [draft, setDraft] = useState<Draft>(() => (channel ? draftOf(channel) : emptyDraft()))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async () => {
    const nextErrors = validate(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }
    const payload: ChannelInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      base_url: draft.base_url.trim().replace(/\/+$/, ''),
      tier: draft.tier,
      priority: Number(draft.priority.trim()),
      timeout_ms: Number(draft.timeout.trim()) * 1000,
      concurrency: Number(draft.concurrency.trim()),
      enabled: draft.enabled,
    }
    setSaving(true)
    try {
      if (channel) {
        await api.channels.update(channel.id, payload)
        showToast(copy.channels.saved)
      } else {
        await api.channels.create(payload)
        showToast(copy.channels.created)
      }
      onSaved()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={channel ? copy.channels.editTitle : copy.channels.createTitle}
      closable
      className={styles.dialog}
      mainClassName={styles.dialogMain}
      onClose={() => {
        if (!saving) {
          onClose()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={saving} onClick={onClose}>
            {copy.common.cancel}
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? copy.common.saving : copy.common.save}
          </Button>
        </>
      }
    >
      <FormGrid>
        <Field label={copy.channels.name} error={errors.name} wide>
          <Input
            value={draft.name}
            autoFocus
            placeholder={copy.channels.name}
            onChange={(event) => update('name', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.channels.kind}>
          <Select
            ariaLabel={copy.channels.kind}
            value={draft.kind}
            options={kindOptions}
            onChange={(value) => update('kind', value)}
          />
        </Field>
        <Field label={copy.channels.tier}>
          <Select
            ariaLabel={copy.channels.tier}
            value={draft.tier}
            options={tierOptions}
            onChange={(value) => update('tier', value)}
          />
        </Field>
        <Field label={copy.channels.baseUrl} error={errors.base_url} wide>
          <Input
            value={draft.base_url}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            onChange={(event) => update('base_url', event.currentTarget.value)}
          />
        </Field>
        <Field
          label={copy.channels.priority}
          hint={copy.channels.priorityHint}
          error={errors.priority}
        >
          <Input
            value={draft.priority}
            inputMode="numeric"
            onChange={(event) => update('priority', event.currentTarget.value)}
          />
        </Field>
        <Field
          label={copy.channels.timeout}
          hint={copy.channels.timeoutHint}
          error={errors.timeout}
        >
          <Input
            value={draft.timeout}
            inputMode="numeric"
            onChange={(event) => update('timeout', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.channels.concurrency} error={errors.concurrency}>
          <Input
            value={draft.concurrency}
            inputMode="numeric"
            onChange={(event) => update('concurrency', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.channels.enabled}>
          <Switch
            checked={draft.enabled}
            label={draft.enabled ? copy.common.enabled : copy.common.disabled}
            onChange={(value) => update('enabled', value)}
          />
        </Field>
      </FormGrid>
    </Modal>
  )
}
