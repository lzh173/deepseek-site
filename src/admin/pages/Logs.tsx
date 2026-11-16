import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { Select } from '../../components/base/Select.js'
import { showToast } from '../../components/base/toastState.js'
import {
  api,
  errorMessage,
  type Channel,
  type KeyItem,
  type LogItem,
  type Model,
  type User,
} from '../api.js'
import { Card } from '../components/Card.js'
import { DataTable, type DataTableColumn } from '../components/DataTable.js'
import { ErrorState } from '../components/EmptyState.js'
import { PageHeader } from '../components/PageHeader.js'
import { Tag, type TagTone } from '../components/Tag.js'
import { copy } from '../copy.js'
import {
  formatCompact,
  formatDateTime,
  formatDuration,
  fromLocalInput,
  startOfTodayIso,
  toLocalInput,
} from '../format.js'
import ui from '../components/ui.module.css'
import styles from './Logs.module.css'

type Filter = {
  ray: string
  userId: string
  model: string
  status: string
  from: string
  to: string
}

const emptyFilter = (): Filter => ({
  ray: '',
  userId: '',
  model: '',
  status: '',
  from: '',
  to: '',
})

const statusOptions: { value: string; label: string }[] = [
  { value: '200', label: copy.logs.statusOptions.ok },
  { value: '400', label: copy.logs.statusOptions.badRequest },
  { value: '401', label: copy.logs.statusOptions.unauthorized },
  { value: '403', label: copy.logs.statusOptions.forbidden },
  { value: '404', label: copy.logs.statusOptions.notFound },
  { value: '413', label: copy.logs.statusOptions.tooLarge },
  { value: '429', label: copy.logs.statusOptions.rateLimited },
  { value: '500', label: copy.logs.statusOptions.internal },
  { value: '503', label: copy.logs.statusOptions.busy },
]

/** 状态码 → 标签颜色：2xx 绿、4xx 黄、5xx 红 */
const statusTone = (status: string | null): TagTone => {
  if (!status) {
    return 'muted'
  }
  if (status.startsWith('2')) {
    return 'success'
  }
  if (status.startsWith('4')) {
    return 'warning'
  }
  if (status.startsWith('5')) {
    return 'danger'
  }
  return 'neutral'
}

const limitOptions = [
  { value: '20', label: '20' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '200', label: '200' },
]

/**
 * 日志页：筛选条 + 分页表格。
 * 时间在界面上是本机时区，提交时换成 UTC ISO；ray 是精确匹配（主键）。
 */
export const Logs = () => {
  const [draft, setDraft] = useState<Filter>(emptyFilter)
  const [applied, setApplied] = useState<Filter>(emptyFilter)
  const [page, setPage] = useState(0)
  const [limit, setLimit] = useState(50)
  const [items, setItems] = useState<LogItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [keys, setKeys] = useState<KeyItem[]>([])
  const [channels, setChannels] = useState<Channel[]>([])

  const loadMeta = useCallback(async () => {
    try {
      const [userResult, modelResult, keyResult, channelResult] = await Promise.all([
        api.users.list(),
        api.models.list(),
        api.keys.list(),
        api.channels.list(),
      ])
      setUsers(userResult.items)
      setModels(modelResult.items)
      setKeys(keyResult.items)
      setChannels(channelResult.items)
    } catch (caught) {
      showToast(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  const userName = useMemo(() => {
    const map = new Map<string, string>()
    for (const user of users) {
      map.set(user.id, user.username)
    }
    return map
  }, [users])

  const keyName = useMemo(() => {
    const map = new Map<string, string>()
    for (const key of keys) {
      map.set(key.id, key.label)
    }
    return map
  }, [keys])

  const channelName = useMemo(() => {
    const map = new Map<string, string>()
    for (const channel of channels) {
      map.set(channel.id, channel.name)
    }
    return map
  }, [channels])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.logs.list({
        ray: applied.ray.trim() || undefined,
        userId: applied.userId || undefined,
        model: applied.model || undefined,
        status: applied.status || undefined,
        from: fromLocalInput(applied.from) ?? undefined,
        to: fromLocalInput(applied.to) ?? undefined,
        limit,
        offset: page * limit,
      })
      setItems(result.items)
      setTotal(result.total)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [applied, page, limit])

  useEffect(() => {
    void load()
  }, [load])

  const update = <K extends keyof Filter>(key: K, value: Filter[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const search = () => {
    setPage(0)
    setApplied({ ...draft })
  }

  const reset = () => {
    setDraft(emptyFilter())
    setPage(0)
    setApplied(emptyFilter())
  }

  const pageCount = Math.max(1, Math.ceil(total / limit))

  const columns: DataTableColumn<LogItem>[] = [
    {
      key: 'time',
      title: copy.logs.columns.time,
      width: '136px',
      render: (row) => (
        <span className={ui.mono} title={row.ts}>
          {formatDateTime(row.ts)}
        </span>
      ),
    },
    {
      key: 'ray',
      title: copy.logs.columns.ray,
      width: '186px',
      render: (row) => (
        <span className={ui.code} title={row.ray}>
          {row.ray}
        </span>
      ),
    },
    {
      key: 'user',
      title: copy.logs.columns.user,
      width: '110px',
      render: (row) => (
        <span className={ui.ellipsis}>
          {row.user_id ? (userName.get(row.user_id) ?? row.user_id) : copy.common.none}
        </span>
      ),
    },
    {
      key: 'model',
      title: copy.logs.columns.model,
      width: '160px',
      render: (row) => (
        <div className={styles.modelCell}>
          <span className={ui.ellipsis}>{row.public_model ?? copy.common.none}</span>
          {row.upstream_model ? (
            <span className={ui.caption} title={row.upstream_model}>
              {row.upstream_model}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'channel',
      title: copy.logs.columns.channel,
      width: '170px',
      render: (row) => (
        <div className={styles.modelCell}>
          <span className={ui.ellipsis}>
            {row.channel_id ? (channelName.get(row.channel_id) ?? row.channel_id) : copy.common.none}
          </span>
          {row.key_id ? (
            <span className={ui.caption} title={row.key_id}>
              {keyName.get(row.key_id) ?? row.key_id}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'tokens',
      title: copy.logs.columns.tokens,
      width: '110px',
      render: (row) => (
        <span className={ui.mono}>
          {formatCompact(row.in_tok)} / {formatCompact(row.out_tok)}
        </span>
      ),
    },
    {
      key: 'duration',
      title: copy.logs.columns.duration,
      width: '84px',
      render: (row) => <span className={ui.mono}>{formatDuration(row.ms)}</span>,
    },
    {
      key: 'status',
      title: copy.logs.columns.status,
      width: '80px',
      render: (row) => (
        <Tag tone={statusTone(row.status)}>{row.status ?? copy.common.none}</Tag>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title={copy.logs.title}
        description={copy.logs.description}
        actions={
          <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
            {copy.common.refresh}
          </Button>
        }
      />

      <Card>
        <div className={styles.filters}>
          <div className={styles.field}>
            <span className={ui.caption}>{copy.logs.ray}</span>
            <input
              className={styles.input}
              value={draft.ray}
              spellCheck={false}
              placeholder={copy.logs.rayPlaceholder}
              onChange={(event) => update('ray', event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  search()
                }
              }}
            />
          </div>
          <div className={styles.field}>
            <span className={ui.caption}>{copy.logs.user}</span>
            <Select
              ariaLabel={copy.logs.user}
              value={draft.userId}
              options={[
                { value: '', label: copy.common.all },
                ...users.map((user) => ({ value: user.id, label: user.username })),
              ]}
              onChange={(value) => update('userId', value)}
            />
          </div>
          <div className={styles.field}>
            <span className={ui.caption}>{copy.logs.model}</span>
            <Select
              ariaLabel={copy.logs.model}
              value={draft.model}
              options={[
                { value: '', label: copy.common.all },
                ...models.map((model) => ({ value: model.id, label: model.id })),
              ]}
              onChange={(value) => update('model', value)}
            />
          </div>
          <div className={styles.field}>
            <span className={ui.caption}>{copy.logs.status}</span>
            <Select
              ariaLabel={copy.logs.status}
              value={draft.status}
              options={[{ value: '', label: copy.common.all }, ...statusOptions]}
              onChange={(value) => update('status', value)}
            />
          </div>
          <div className={styles.field}>
            <span className={ui.caption}>{copy.logs.from}</span>
            <input
              className={styles.date}
              type="datetime-local"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) => update('from', event.currentTarget.value)}
            />
          </div>
          <div className={styles.field}>
            <span className={ui.caption}>{copy.logs.to}</span>
            <input
              className={styles.date}
              type="datetime-local"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => update('to', event.currentTarget.value)}
            />
          </div>
          <div className={styles.filterActions}>
            <Button size="s" disabled={loading} onClick={search}>
              {copy.common.search}
            </Button>
            <Button variant="outlined" size="s" onClick={reset}>
              {copy.common.reset}
            </Button>
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                const today = startOfTodayIso()
                const local = toLocalInput(today)
                setDraft((prev) => ({ ...prev, from: local }))
              }}
            >
              {copy.logs.today}
            </Button>
          </div>
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
            rowKey={(row) => row.ray}
            loading={loading}
            skeletonRows={8}
            emptyTitle={copy.logs.empty}
            emptyHint={copy.logs.emptyHint}
          />
        )}
        <div className={styles.footer}>
          <span className={ui.caption}>{copy.logs.total(total)}</span>
          <span className={ui.spacer} />
          <span className={ui.caption}>{copy.logs.pageSize}</span>
          <Select
            ariaLabel={copy.logs.pageSize}
            value={String(limit)}
            options={limitOptions}
            onChange={(value) => {
              setLimit(Number(value))
              setPage(0)
            }}
          />
          <Button
            variant="outlined"
            size="s"
            disabled={loading || page === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            {copy.logs.prev}
          </Button>
          <span className={ui.caption}>{copy.logs.page(page + 1, pageCount)}</span>
          <Button
            variant="outlined"
            size="s"
            disabled={loading || page + 1 >= pageCount}
            onClick={() => setPage((value) => value + 1)}
          >
            {copy.logs.next}
          </Button>
        </div>
      </Card>
    </>
  )
}
