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
  type Caps,
  type CapsKey,
  type MatrixRow,
  type Model,
  type ModelInput,
  type Tier,
} from '../api.js'
import { Card } from '../components/Card.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { DataTable, type DataTableColumn } from '../components/DataTable.js'
import { EmptyState, ErrorState } from '../components/EmptyState.js'
import { Field, FormGrid, Input, Switch } from '../components/forms.js'
import { PageHeader } from '../components/PageHeader.js'
import { Tag } from '../components/Tag.js'
import { copy } from '../copy.js'
import { formatContext } from '../format.js'
import ui from '../components/ui.module.css'
import styles from './Models.module.css'

const capKeys: CapsKey[] = ['vision', 'reasoning', 'web_search', 'read_url', 'file_parse']

const emptyCaps = (): Caps => ({
  vision: false,
  reasoning: false,
  web_search: false,
  read_url: false,
  file_parse: false,
})

const tierTag = (tier: Tier) => (
  <Tag tone={tier === 'paid' ? 'brand' : 'neutral'}>
    {tier === 'paid' ? copy.models.tierPaid : copy.models.tierFree}
  </Tag>
)

const CapsCell = ({ caps }: { caps: Caps }) => {
  const enabled = capKeys.filter((key) => caps[key])
  if (enabled.length === 0) {
    return <span className={ui.muted}>{copy.common.none}</span>
  }
  return (
    <div className={ui.rowWrap}>
      {enabled.map((key) => (
        <Tag key={key} tone="neutral">
          {copy.models.capsLabels[key]}
        </Tag>
      ))}
    </div>
  )
}

const matrixColumns: DataTableColumn<MatrixRow>[] = [
  {
    key: 'channel',
    title: copy.models.matrixColumns.channel,
    width: '160px',
    render: (row) => <span className={ui.ellipsis}>{row.channel_name}</span>,
  },
  {
    key: 'key',
    title: copy.models.matrixColumns.key,
    width: '180px',
    render: (row) => <span className={ui.ellipsis}>{row.key_label}</span>,
  },
  {
    key: 'upstream',
    title: copy.models.matrixColumns.upstream,
    render: (row) => <span className={ui.code}>{row.upstream_model}</span>,
  },
  {
    key: 'weight',
    title: copy.models.matrixColumns.weight,
    width: '72px',
    render: (row) => <span className={ui.mono}>{row.weight}</span>,
  },
  {
    key: 'status',
    title: copy.models.matrixColumns.status,
    width: '88px',
    render: (row) => (
      <Tag tone={row.enabled ? 'success' : 'muted'}>
        {row.enabled ? copy.common.enabled : copy.common.disabled}
      </Tag>
    ),
  },
]

/** 模型页：公开模型 CRUD + 能力位 + 点行查看 Key 矩阵 */
export const Models = () => {
  const [items, setItems] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [matrix, setMatrix] = useState<{ modelId: string; rows: MatrixRow[] } | null>(null)
  const [matrixLoading, setMatrixLoading] = useState(false)
  const [modal, setModal] = useState<{ model: Model | null } | null>(null)
  const [deleting, setDeleting] = useState<Model | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.models.list()
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

  const loadMatrix = useCallback(async (modelId: string) => {
    setMatrixLoading(true)
    try {
      const result = await api.models.matrix(modelId)
      setMatrix({ modelId, rows: result.items })
    } catch (caught) {
      showToast(errorMessage(caught))
      setMatrix(null)
    } finally {
      setMatrixLoading(false)
    }
  }, [])

  const select = (model: Model) => {
    if (selectedId === model.id) {
      setSelectedId(null)
      setMatrix(null)
      return
    }
    setSelectedId(model.id)
    void loadMatrix(model.id)
  }

  const confirmDelete = async () => {
    if (!deleting) {
      return
    }
    setDeletePending(true)
    try {
      await api.models.remove(deleting.id)
      showToast(copy.models.deleted)
      if (selectedId === deleting.id) {
        setSelectedId(null)
        setMatrix(null)
      }
      setDeleting(null)
      await load()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setDeletePending(false)
    }
  }

  const columns: DataTableColumn<Model>[] = [
    {
      key: 'id',
      title: copy.models.columns.id,
      width: '150px',
      render: (row) => <span className={ui.code}>{row.id}</span>,
    },
    {
      key: 'displayName',
      title: copy.models.columns.displayName,
      width: '160px',
      render: (row) => (
        <span className={ui.ellipsis} title={row.display_name}>
          {row.display_name}
        </span>
      ),
    },
    {
      key: 'tier',
      title: copy.models.columns.tier,
      width: '76px',
      render: (row) => tierTag(row.tier),
    },
    {
      key: 'caps',
      title: copy.models.columns.caps,
      render: (row) => <CapsCell caps={row.caps} />,
    },
    {
      key: 'context',
      title: copy.models.columns.context,
      width: '88px',
      render: (row) => <span className={ui.mono}>{formatContext(row.context)}</span>,
    },
    {
      key: 'status',
      title: copy.models.columns.status,
      width: '76px',
      render: (row) => (
        <Tag tone={row.enabled ? 'success' : 'muted'}>
          {row.enabled ? copy.common.enabled : copy.common.disabled}
        </Tag>
      ),
    },
    {
      key: 'actions',
      title: copy.common.actions,
      align: 'end',
      width: '196px',
      render: (row) => (
        <div className={ui.rowEnd} onClick={(event) => event.stopPropagation()}>
          <Button variant="outlined" size="s" onClick={() => select(row)}>
            {copy.models.matrix}
          </Button>
          <Button variant="outlined" size="s" onClick={() => setModal({ model: row })}>
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
        title={copy.models.title}
        description={copy.models.description}
        actions={
          <>
            <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
              {copy.common.refresh}
            </Button>
            <Button size="m" onClick={() => setModal({ model: null })}>
              {copy.models.create}
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
            skeletonRows={4}
            selectedKey={selectedId}
            onRowClick={select}
            emptyTitle={copy.models.empty}
            emptyHint={copy.models.emptyHint}
            emptyAction={
              <Button size="s" onClick={() => setModal({ model: null })}>
                {copy.models.create}
              </Button>
            }
          />
        )}
      </Card>

      {selectedId ? (
        <Card
          flush
          title={copy.models.matrixTitle(selectedId)}
          description={copy.models.matrixDescription}
          actions={
            <>
              <Button
                variant="outlined"
                size="s"
                disabled={matrixLoading}
                onClick={() => void loadMatrix(selectedId)}
              >
                {copy.common.refresh}
              </Button>
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  setSelectedId(null)
                  setMatrix(null)
                }}
              >
                {copy.common.close}
              </Button>
            </>
          }
        >
          {matrix && matrix.modelId === selectedId ? (
            matrix.rows.length === 0 ? (
              <EmptyState title={copy.models.matrixEmpty} hint={copy.models.matrixEmptyHint} />
            ) : (
              <DataTable
                columns={matrixColumns}
                rows={matrix.rows}
                rowKey={(row) => `${row.key_id}-${row.upstream_model}`}
                fixed
              />
            )
          ) : (
            <DataTable
              columns={matrixColumns}
              rows={[]}
              rowKey={(row) => `${row.key_id}-${row.upstream_model}`}
              loading={matrixLoading}
              fixed
            />
          )}
        </Card>
      ) : (
        <div className={ui.caption}>{copy.models.selectHint}</div>
      )}

      {modal ? (
        <ModelForm
          model={modal.model}
          onClose={() => setModal(null)}
          onSaved={(saved) => {
            setModal(null)
            void load()
            if (selectedId === saved.id) {
              void loadMatrix(saved.id)
            }
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={copy.models.deleteTitle}
          description={copy.models.deleteDescription(deleting.id)}
          busy={deletePending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  )
}

type Draft = {
  id: string
  display_name: string
  tier: Tier
  context: string
  caps: Caps
  fallback: string
  enabled: boolean
}

type DraftErrors = { id?: string; display_name?: string; context?: string; fallback?: string }

const draftOf = (model: Model | null): Draft =>
  model
    ? {
        id: model.id,
        display_name: model.display_name,
        tier: model.tier,
        context: String(model.context),
        caps: model.caps,
        fallback: model.fallback_chain.join(', '),
        enabled: model.enabled,
      }
    : {
        id: '',
        display_name: '',
        tier: 'free',
        context: '32768',
        caps: emptyCaps(),
        fallback: '',
        enabled: true,
      }

/** 新建/编辑表单：ID 创建后不可改（PATCH 不接受 id） */
const ModelForm = ({
  model,
  onClose,
  onSaved,
}: {
  model: Model | null
  onClose: () => void
  onSaved: (model: Model) => void
}) => {
  const [draft, setDraft] = useState<Draft>(() => draftOf(model))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async () => {
    const fallback = draft.fallback
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    const nextErrors: DraftErrors = {}
    if (!model && !draft.id.trim()) {
      nextErrors.id = copy.models.validationId
    }
    if (!draft.display_name.trim()) {
      nextErrors.display_name = copy.common.validation.required
    }
    if (!/^\d+$/.test(draft.context.trim()) || Number(draft.context) < 1) {
      nextErrors.context = copy.models.validationContext
    }
    if (
      draft.fallback.split(',').some((part) => part.trim().length === 0) &&
      draft.fallback.trim().length > 0
    ) {
      nextErrors.fallback = copy.models.validationChain
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    const payload: ModelInput = {
      id: draft.id.trim(),
      display_name: draft.display_name.trim(),
      context: Number(draft.context.trim()),
      caps: draft.caps,
      tier: draft.tier,
      fallback_chain: fallback,
      enabled: draft.enabled,
    }
    setSaving(true)
    try {
      const result = model
        ? await api.models.update(model.id, {
            display_name: payload.display_name,
            context: payload.context,
            caps: payload.caps,
            tier: payload.tier,
            fallback_chain: payload.fallback_chain,
            enabled: payload.enabled,
          })
        : await api.models.create(payload)
      showToast(model ? copy.models.saved : copy.models.created)
      onSaved(result.item)
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={model ? copy.models.editTitle : copy.models.createTitle}
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
        <Field label={copy.models.id} hint={copy.models.idHint} error={errors.id}>
          <Input
            value={draft.id}
            autoFocus={!model}
            disabled={Boolean(model)}
            spellCheck={false}
            onChange={(event) => update('id', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.models.displayName} error={errors.display_name}>
          <Input
            value={draft.display_name}
            onChange={(event) => update('display_name', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.models.tier}>
          <Select
            ariaLabel={copy.models.tier}
            value={draft.tier}
            options={[
              { value: 'free', label: copy.models.tierFree },
              { value: 'paid', label: copy.models.tierPaid },
            ]}
            onChange={(value) => update('tier', value)}
          />
        </Field>
        <Field label={copy.models.context} hint={copy.models.contextHint} error={errors.context}>
          <Input
            value={draft.context}
            inputMode="numeric"
            onChange={(event) => update('context', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.models.caps} wide>
          <div className={styles.capsGrid}>
            {capKeys.map((key) => (
              <Switch
                key={key}
                checked={draft.caps[key]}
                label={copy.models.capsLabels[key]}
                onChange={(value) => update('caps', { ...draft.caps, [key]: value })}
              />
            ))}
          </div>
        </Field>
        <Field label={copy.models.fallbackChain} hint={copy.models.fallbackHint} error={errors.fallback} wide>
          <Input
            value={draft.fallback}
            spellCheck={false}
            onChange={(event) => update('fallback', event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.models.enabled}>
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
