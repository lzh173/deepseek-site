import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { IconButton } from '../../components/base/IconButton.js'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconTrashOutline16,
} from '../../components/base/icons.js'
import { Modal } from '../../components/base/Modal.js'
import { Select } from '../../components/base/Select.js'
import { showToast } from '../../components/base/toastState.js'
import {
  api,
  errorMessage,
  type Channel,
  type KeyItem,
  type KeyModel,
  type Model,
  type ProbeResult,
} from '../api.js'
import { Card } from '../components/Card.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { DataTable, type DataTableColumn } from '../components/DataTable.js'
import { ErrorState } from '../components/EmptyState.js'
import { Field, FormGrid, Input, Switch, Textarea } from '../components/forms.js'
import { PageHeader } from '../components/PageHeader.js'
import { Tag } from '../components/Tag.js'
import { copy } from '../copy.js'
import { formatDateTime, formatRemaining } from '../format.js'
import ui from '../components/ui.module.css'
import styles from './Keys.module.css'

const statusTones = { active: 'success', cooling: 'warning', disabled: 'muted' } as const

const statusTag = (item: KeyItem) => (
  <Tag tone={statusTones[item.status]}>{copy.keys.status[item.status]}</Tag>
)

/** 用量条：没有配额（0）时不画条，只显示已用次数 */
const UsageCell = ({ item }: { item: KeyItem }) => {
  if (item.daily_quota <= 0) {
    return (
      <div className={styles.usage}>
        <span className={ui.mono}>{item.used_today} / ∞</span>
      </div>
    )
  }
  const ratio = item.used_today / item.daily_quota
  const tone = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : 'success'
  return (
    <div className={styles.usage}>
      <div className={ui.bar}>
        <div
          className={ui.barFill}
          data-tone={tone}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <span className={ui.mono}>{copy.keys.usage(item.used_today, item.daily_quota)}</span>
    </div>
  )
}

const CooldownCell = ({ item, now }: { item: KeyItem; now: number }) => {
  if (!item.cooldown_until) {
    return <span className={ui.muted}>{copy.keys.noCooldown}</span>
  }
  const remaining = formatRemaining(item.cooldown_until, now)
  return (
    <div className={styles.cooldown}>
      <span className={ui.mono}>{formatDateTime(item.cooldown_until)}</span>
      {remaining ? <span className={ui.caption}>{copy.keys.remaining(remaining)}</span> : null}
    </div>
  )
}

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

/**
 * 账号池：按渠道/状态筛选、批量导入、单条测试与重置、模型映射内联编辑。
 * 任何接口都不返回明文，列表只显示掩码。
 */
export const Keys = () => {
  const [channels, setChannels] = useState<Channel[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [items, setItems] = useState<KeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [channelId, setChannelId] = useState('')
  const [status, setStatus] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<KeyItem | null>(null)
  const [deleting, setDeleting] = useState<KeyItem | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [testingId, setTestingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // 冷却倒计时每 30 秒刷一次即可，不必按秒重渲染整张表
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const loadMeta = useCallback(async () => {
    try {
      const [channelResult, modelResult] = await Promise.all([
        api.channels.list(),
        api.models.list(),
      ])
      setChannels(channelResult.items)
      setModels(modelResult.items)
    } catch (caught) {
      showToast(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.keys.list({
        channelId: channelId || undefined,
        status: status || undefined,
      })
      setItems(result.items)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [channelId, status])

  useEffect(() => {
    void load()
  }, [load])

  const channelLabel = (id: string) => channels.find((item) => item.id === id)?.name ?? id
  const replaceItem = (next: KeyItem) => {
    setItems((prev) => prev.map((item) => (item.id === next.id ? next : item)))
  }

  const runTest = async (item: KeyItem) => {
    setTestingId(item.id)
    try {
      const result = await api.keys.test(item.id)
      setProbes((prev) => ({ ...prev, [item.id]: result }))
      if (!result.ok) {
        showToast(result.error ?? copy.channels.probeFailed(result.latency_ms))
      }
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setTestingId(null)
    }
  }

  const reset = async (item: KeyItem) => {
    try {
      const result = await api.keys.reset(item.id)
      replaceItem(result.item)
      showToast(copy.keys.resetDone)
    } catch (caught) {
      showToast(errorMessage(caught))
    }
  }

  const confirmDelete = async () => {
    if (!deleting) {
      return
    }
    setDeletePending(true)
    try {
      await api.keys.remove(deleting.id)
      showToast(copy.keys.deleted)
      setDeleting(null)
      if (expandedId === deleting.id) {
        setExpandedId(null)
      }
      await load()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setDeletePending(false)
    }
  }

  const columns: DataTableColumn<KeyItem>[] = [
    {
      key: 'expand',
      title: '',
      width: '36px',
      render: (row) => (
        <IconButton
          icon={
            expandedId === row.id ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />
          }
          tooltip={copy.keys.models}
          onClick={(event) => {
            event.stopPropagation()
            setExpandedId((prev) => (prev === row.id ? null : row.id))
          }}
        />
      ),
    },
    {
      key: 'secret',
      title: copy.keys.columns.secret,
      width: '150px',
      render: (row) => (
        <div className={styles.secretCell}>
          <span className={ui.mono}>{row.secret_masked}</span>
          <span className={ui.caption}>
            {row.models.length > 0 ? copy.keys.modelsCount(row.models.length) : copy.keys.noModels}
          </span>
        </div>
      ),
    },
    {
      key: 'label',
      title: copy.keys.columns.label,
      width: '150px',
      render: (row) => (
        <div className={styles.labelCell}>
          <span className={ui.ellipsis}>{row.label}</span>
          <span className={ui.caption}>{row.group_label ?? copy.common.none}</span>
        </div>
      ),
    },
    {
      key: 'channel',
      title: copy.keys.columns.channel,
      width: '128px',
      render: (row) => (
        <span className={ui.ellipsis} title={channelLabel(row.channel_id)}>
          {channelLabel(row.channel_id)}
        </span>
      ),
    },
    {
      key: 'weight',
      title: copy.keys.columns.weight,
      width: '64px',
      render: (row) => <span className={ui.mono}>{row.weight}</span>,
    },
    {
      key: 'status',
      title: copy.keys.columns.status,
      width: '88px',
      render: (row) => statusTag(row),
    },
    {
      key: 'usage',
      title: copy.keys.columns.usage,
      width: '148px',
      render: (row) => <UsageCell item={row} />,
    },
    {
      key: 'cooldown',
      title: copy.keys.columns.cooldown,
      width: '164px',
      render: (row) => <CooldownCell item={row} now={now} />,
    },
    {
      key: 'probe',
      title: copy.keys.columns.probe,
      width: '160px',
      render: (row) => <ProbeCell probe={probes[row.id]} testing={testingId === row.id} />,
    },
    {
      key: 'actions',
      title: copy.common.actions,
      align: 'end',
      width: '210px',
      render: (row) => (
        <div className={ui.rowEnd} onClick={(event) => event.stopPropagation()}>
          <Button
            variant="outlined"
            size="s"
            disabled={testingId === row.id}
            onClick={() => void runTest(row)}
          >
            {copy.keys.test}
          </Button>
          <Button variant="outlined" size="s" onClick={() => void reset(row)}>
            {copy.keys.reset}
          </Button>
          <Button variant="outlined" size="s" onClick={() => setEditing(row)}>
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

  const channelOptions = [
    { value: '', label: copy.common.all },
    ...channels.map((item) => ({ value: item.id, label: item.name })),
  ]

  return (
    <>
      <PageHeader
        title={copy.keys.title}
        description={copy.keys.description}
        actions={
          <>
            <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
              {copy.common.refresh}
            </Button>
            <Button size="m" disabled={channels.length === 0} onClick={() => setImportOpen(true)}>
              {copy.keys.import}
            </Button>
          </>
        }
      />

      <Card>
        <div className={styles.filters}>
          <div className={styles.filter}>
            <span className={ui.caption}>{copy.keys.filterChannel}</span>
            <Select
              ariaLabel={copy.keys.filterChannel}
              value={channelId}
              options={channelOptions}
              onChange={setChannelId}
            />
          </div>
          <div className={styles.filter}>
            <span className={ui.caption}>{copy.keys.filterStatus}</span>
            <Select
              ariaLabel={copy.keys.filterStatus}
              value={status}
              options={[
                { value: '', label: copy.common.all },
                { value: 'active', label: copy.keys.status.active },
                { value: 'cooling', label: copy.keys.status.cooling },
                { value: 'disabled', label: copy.keys.status.disabled },
              ]}
              onChange={setStatus}
            />
          </div>
          {channelId || status ? (
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                setChannelId('')
                setStatus('')
              }}
            >
              {copy.keys.clearFilter}
            </Button>
          ) : null}
        </div>
      </Card>

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
            expandedKey={expandedId}
            renderExpanded={(row) => (
              <KeyModelsEditor
                key={row.id}
                item={row}
                models={models}
                onSaved={(next) => {
                  replaceItem(next)
                  showToast(copy.keys.modelsSaved)
                }}
              />
            )}
            emptyTitle={copy.keys.empty}
            emptyHint={copy.keys.emptyHint}
            emptyAction={
              channels.length > 0 ? (
                <Button size="s" onClick={() => setImportOpen(true)}>
                  {copy.keys.import}
                </Button>
              ) : null
            }
          />
        )}
      </Card>

      {importOpen ? (
        <ImportDialog
          channels={channels}
          defaultChannelId={channelId}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            void load()
          }}
        />
      ) : null}

      {editing ? (
        <KeyEditDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            replaceItem(next)
            setEditing(null)
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={copy.keys.deleteTitle}
          description={copy.keys.deleteDescription(deleting.label)}
          busy={deletePending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  )
}

/** 展开行：Key ⇄ 模型映射的全量编辑（PUT 会整体替换） */
const KeyModelsEditor = ({
  item,
  models,
  onSaved,
}: {
  item: KeyItem
  models: Model[]
  onSaved: (next: KeyItem) => void
}) => {
  const [rows, setRows] = useState<KeyModel[]>(() => item.models.map((model) => ({ ...model })))
  const [saving, setSaving] = useState(false)

  const modelOptions = models.map((model) => ({
    value: model.id,
    label: `${model.id} · ${model.display_name}`,
  }))

  const updateRow = (index: number, patch: Partial<KeyModel>) => {
    setRows((prev) =>
      prev.map((row, position) => (position === index ? { ...row, ...patch } : row))
    )
  }

  const save = async () => {
    const invalid = rows.some((row) => !row.public_model || row.upstream_model.trim().length === 0)
    if (invalid) {
      showToast(copy.keys.modelsInvalid)
      return
    }
    setSaving(true)
    try {
      const result = await api.keys.putModels(
        item.id,
        rows.map((row) => ({ ...row, upstream_model: row.upstream_model.trim() }))
      )
      onSaved(result.item)
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.editor}>
      <div className={ui.between}>
        <div>
          <div className={ui.sectionTitle}>{copy.keys.modelsTitle}</div>
          <div className={ui.caption}>{copy.keys.modelsDescription}</div>
        </div>
        <div className={ui.row}>
          <Button
            variant="outlined"
            size="s"
            disabled={models.length === 0}
            onClick={() =>
              setRows((prev) => [
                ...prev,
                { public_model: models[0]?.id ?? '', upstream_model: '', weight: 1, enabled: true },
              ])
            }
          >
            {copy.keys.addRow}
          </Button>
          <Button size="s" disabled={saving} onClick={() => void save()}>
            {saving ? copy.common.saving : copy.keys.saveModels}
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.editorEmpty}>
          <div className={ui.caption}>{copy.keys.modelsEmpty}</div>
          <div className={ui.caption}>{copy.keys.modelsEmptyHint}</div>
        </div>
      ) : (
        <div className={styles.modelRows}>
          {rows.map((row, index) => (
            <div
              key={`${row.public_model}-${row.upstream_model}-${index}`}
              className={styles.modelRow}
            >
              <Select
                ariaLabel={copy.keys.publicModel}
                value={row.public_model}
                options={modelOptions}
                placeholder={copy.keys.publicModel}
                onChange={(value) => updateRow(index, { public_model: value })}
              />
              <Input
                value={row.upstream_model}
                placeholder={copy.keys.upstream}
                spellCheck={false}
                onChange={(event) =>
                  updateRow(index, { upstream_model: event.currentTarget.value })
                }
              />
              <Input
                value={String(row.weight)}
                inputMode="numeric"
                aria-label={copy.keys.weight}
                onChange={(event) => {
                  const parsed = Number(event.currentTarget.value.replace(/\D/g, ''))
                  updateRow(index, { weight: Number.isNaN(parsed) ? 0 : parsed })
                }}
              />
              <Switch
                checked={row.enabled}
                label={copy.keys.enabledModel}
                onChange={(value) => updateRow(index, { enabled: value })}
              />
              <IconButton
                icon={<IconTrashOutline16 />}
                tooltip={copy.common.delete}
                onClick={() => setRows((prev) => prev.filter((_, position) => position !== index))}
              />
            </div>
          ))}
        </div>
      )}

      <div className={ui.caption}>{copy.keys.modelsPublicHint}</div>
    </div>
  )
}

/** 批量导入：textarea 一行一把，空行忽略 */
const ImportDialog = ({
  channels,
  defaultChannelId,
  onClose,
  onImported,
}: {
  channels: Channel[]
  defaultChannelId: string
  onClose: () => void
  onImported: () => void
}) => {
  const [channelId, setChannelId] = useState(defaultChannelId || channels[0]?.id || '')
  const [text, setText] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('')
  const [weight, setWeight] = useState('1')
  const [quota, setQuota] = useState('1000')
  const [saving, setSaving] = useState(false)

  const secrets = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const submit = async () => {
    if (!channelId) {
      showToast(copy.keys.importNoChannel)
      return
    }
    if (secrets.length === 0) {
      showToast(copy.keys.importEmpty)
      return
    }
    setSaving(true)
    try {
      const result = await api.keys.import({
        channel_id: channelId,
        keys: secrets.join('\n'),
        label: label.trim() || undefined,
        group_label: group.trim() || null,
        weight: Number(weight) || 0,
        daily_quota: Number(quota) || 0,
      })
      showToast(copy.keys.importDone(result.created))
      onImported()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={copy.keys.importTitle}
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
          <Button disabled={saving || secrets.length === 0} onClick={() => void submit()}>
            {saving ? copy.common.saving : copy.keys.import}
          </Button>
        </>
      }
    >
      <FormGrid>
        <Field label={copy.keys.importChannel} wide>
          <Select
            ariaLabel={copy.keys.importChannel}
            value={channelId}
            options={channels.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setChannelId}
          />
        </Field>
        <Field
          label={copy.keys.importText}
          wide
          hint={copy.keys.importPlaceholderHint(secrets.length)}
        >
          <Textarea
            value={text}
            autoFocus
            spellCheck={false}
            placeholder={copy.keys.importTextPlaceholder}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.keys.label} hint={copy.keys.labelHint}>
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
        </Field>
        <Field label={copy.keys.group}>
          <Input value={group} onChange={(event) => setGroup(event.currentTarget.value)} />
        </Field>
        <Field label={copy.keys.weight}>
          <Input
            value={weight}
            inputMode="numeric"
            onChange={(event) => setWeight(event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.keys.dailyQuota} hint={copy.keys.dailyQuotaHint}>
          <Input
            value={quota}
            inputMode="numeric"
            onChange={(event) => setQuota(event.currentTarget.value)}
          />
        </Field>
      </FormGrid>
    </Modal>
  )
}

/** 单条编辑：只开放 label / group_label / weight / daily_quota（状态由池子自己管） */
const KeyEditDialog = ({
  item,
  onClose,
  onSaved,
}: {
  item: KeyItem
  onClose: () => void
  onSaved: (next: KeyItem) => void
}) => {
  const [label, setLabel] = useState(item.label)
  const [group, setGroup] = useState(item.group_label ?? '')
  const [weight, setWeight] = useState(String(item.weight))
  const [quota, setQuota] = useState(String(item.daily_quota))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!label.trim()) {
      setError(copy.common.validation.required)
      return
    }
    setError(null)
    setSaving(true)
    try {
      const result = await api.keys.update(item.id, {
        label: label.trim(),
        group_label: group.trim() || null,
        weight: Number(weight) || 0,
        daily_quota: Number(quota) || 0,
      })
      showToast(copy.keys.saved)
      onSaved(result.item)
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={copy.keys.editTitle}
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
      <div className={styles.editSecret}>
        <span className={ui.caption}>{copy.keys.columns.secret}</span>
        <span className={ui.mono}>{item.secret_masked}</span>
      </div>
      <FormGrid>
        <Field label={copy.keys.label} error={error} wide>
          <Input
            value={label}
            autoFocus
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.keys.group}>
          <Input value={group} onChange={(event) => setGroup(event.currentTarget.value)} />
        </Field>
        <Field label={copy.keys.weight}>
          <Input
            value={weight}
            inputMode="numeric"
            onChange={(event) => setWeight(event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.keys.dailyQuota} hint={copy.keys.dailyQuotaHint}>
          <Input
            value={quota}
            inputMode="numeric"
            onChange={(event) => setQuota(event.currentTarget.value)}
          />
        </Field>
      </FormGrid>
    </Modal>
  )
}
