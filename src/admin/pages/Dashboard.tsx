import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import {
  api,
  errorMessage,
  type Channel,
  type KeyItem,
  type LogItem,
  type SystemInfo,
} from '../api.js'
import { Card } from '../components/Card.js'
import { DataTable, type DataTableColumn } from '../components/DataTable.js'
import { ErrorState } from '../components/EmptyState.js'
import { PageHeader } from '../components/PageHeader.js'
import { Skeleton } from '../components/Skeleton.js'
import { Tag } from '../components/Tag.js'
import { copy } from '../copy.js'
import {
  formatBytes,
  formatCompact,
  formatDateTime,
  formatNumber,
  formatPercent,
  startOfTodayIso,
} from '../format.js'
import ui from '../components/ui.module.css'
import styles from './Dashboard.module.css'

type DashboardData = {
  /** 今日请求总数（服务端按同一次查询数的） */
  total: number
  /** 最近 200 条今日请求，用于估算失败数、失败率与错误列表 */
  sample: LogItem[]
  channels: Channel[]
  keys: KeyItem[]
  system: SystemInfo
}

const errorColumns: DataTableColumn<LogItem>[] = [
  {
    key: 'time',
    title: copy.dashboard.columns.time,
    width: '136px',
    render: (row) => <span className={ui.mono}>{formatDateTime(row.ts)}</span>,
  },
  {
    key: 'ray',
    title: copy.dashboard.columns.ray,
    width: '184px',
    render: (row) => <span className={ui.code}>{row.ray}</span>,
  },
  {
    key: 'model',
    title: copy.dashboard.columns.model,
    width: '120px',
    render: (row) => <span className={ui.ellipsis}>{row.public_model ?? copy.common.none}</span>,
  },
  {
    key: 'status',
    title: copy.dashboard.columns.status,
    width: '72px',
    render: (row) => <Tag tone="danger">{row.status ?? copy.common.none}</Tag>,
  },
  {
    key: 'err',
    title: copy.dashboard.columns.error,
    render: (row) => (
      <span className={ui.ellipsis} title={row.err ?? ''}>
        {row.err ?? copy.common.none}
      </span>
    ),
  },
]

/**
 * 仪表盘：今日概览 + 最近错误 + 渠道状态。
 *
 * 失败数没有独立接口，按最近 200 条请求估算（GOAL.md 允许），页面上明确标注了口径。
 */
export const Dashboard = () => {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [logs, channels, keys, system] = await Promise.all([
        api.logs.list({ from: startOfTodayIso(), limit: 200 }),
        api.channels.list(),
        api.keys.list(),
        api.system.info(),
      ])
      setData({
        total: logs.total,
        sample: logs.items,
        channels: channels.items,
        keys: keys.items,
        system: {
          db: system.db,
          files: system.files,
          tables: system.tables,
        },
      })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const actions = (
    <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
      {loading ? copy.common.loading : copy.common.refresh}
    </Button>
  )

  if (error && !data) {
    return (
      <>
        <PageHeader title={copy.dashboard.title} description={copy.dashboard.description} />
        <Card>
          <ErrorState message={error} onRetry={() => void load()} />
        </Card>
      </>
    )
  }

  const sample = data?.sample ?? []
  const failures = sample.filter((item) => item.status !== '200')
  const recentErrors = failures.slice(0, 10)
  const failureRate = sample.length > 0 ? failures.length / sample.length : 0
  const tokens = sample.reduce((sum, item) => sum + (item.in_tok ?? 0) + (item.out_tok ?? 0), 0)

  const keys = data?.keys ?? []
  const activeKeys = keys.filter((item) => item.status === 'active').length
  const coolingKeys = keys.filter((item) => item.status === 'cooling').length
  const disabledKeys = keys.filter((item) => item.status === 'disabled').length
  const share = (count: number) => (keys.length > 0 ? (count / keys.length) * 100 : 0)

  const channels = data?.channels ?? []
  const enabledChannels = channels.filter((item) => item.enabled).length

  return (
    <>
      <PageHeader
        title={copy.dashboard.title}
        description={copy.dashboard.description}
        actions={actions}
      />

      <div className={styles.stats}>
        <Card className={styles.stat}>
          <div className={styles.statLabel}>{copy.dashboard.todayRequests}</div>
          {data ? (
            <div className={styles.statValue}>{formatNumber(data.total)}</div>
          ) : (
            <Skeleton width="96px" height={30} />
          )}
          <div className={ui.bar}>
            <div
              className={ui.barFill}
              data-tone="danger"
              style={{ width: `${Math.min(100, failureRate * 100)}%` }}
            />
          </div>
          <div className={styles.statSub}>
            {copy.dashboard.todayFailures} {formatNumber(failures.length)} ·{' '}
            {copy.dashboard.failureRate} {formatPercent(failureRate)}
          </div>
          <div className={ui.caption}>{copy.dashboard.sampled(sample.length)}</div>
          <div className={ui.caption}>
            {copy.dashboard.estimateHint} · tokens {formatCompact(tokens)}
          </div>
        </Card>

        <Card className={styles.stat}>
          <div className={styles.statLabel}>{copy.dashboard.keyPool}</div>
          {data ? (
            <div className={styles.statValue}>{formatNumber(keys.length)}</div>
          ) : (
            <Skeleton width="72px" height={30} />
          )}
          <div className={styles.segments}>
            <div
              className={styles.segment}
              data-tone="success"
              style={{ width: `${share(activeKeys)}%` }}
            />
            <div
              className={styles.segment}
              data-tone="warning"
              style={{ width: `${share(coolingKeys)}%` }}
            />
            <div
              className={styles.segment}
              data-tone="muted"
              style={{ width: `${share(disabledKeys)}%` }}
            />
          </div>
          <div className={styles.statSub}>
            {copy.dashboard.keyPoolHint(activeKeys, coolingKeys, disabledKeys)}
          </div>
        </Card>

        <Card className={styles.stat}>
          <div className={styles.statLabel}>{copy.dashboard.channelCount}</div>
          {data ? (
            <div className={styles.statValue}>{formatNumber(channels.length)}</div>
          ) : (
            <Skeleton width="64px" height={30} />
          )}
          <div className={ui.bar}>
            <div
              className={ui.barFill}
              data-tone="success"
              style={{
                width: `${channels.length > 0 ? (enabledChannels / channels.length) * 100 : 0}%`,
              }}
            />
          </div>
          <div className={styles.statSub}>
            {copy.dashboard.channelHint(enabledChannels, channels.length - enabledChannels)}
          </div>
        </Card>

        <Card className={styles.stat}>
          <div className={styles.statLabel}>{copy.dashboard.storage}</div>
          {data ? (
            <div className={styles.statValue}>{formatBytes(data.system.files.bytes)}</div>
          ) : (
            <Skeleton width="88px" height={30} />
          )}
          <div className={styles.statSub}>
            {data ? copy.dashboard.storageHint(data.system.files.count) : null}
          </div>
          <div className={ui.caption}>
            {data ? copy.dashboard.dbSize(formatBytes(data.system.db.size_bytes)) : null}
          </div>
        </Card>
      </div>

      <div className={styles.columns}>
        <Card
          className={styles.errorsCard}
          flush
          title={copy.dashboard.recentErrors}
          description={copy.dashboard.recentErrorsDescription}
        >
          <DataTable
            columns={errorColumns}
            rows={recentErrors}
            rowKey={(row) => row.ray}
            loading={loading && !data}
            fixed
            emptyTitle={copy.dashboard.noErrors}
          />
        </Card>

        <Card
          title={copy.dashboard.channelStatus}
          description={copy.dashboard.channelStatusDescription}
        >
          {channels.length === 0 ? (
            <div className={ui.caption}>{loading ? copy.common.loading : copy.common.empty}</div>
          ) : (
            <ul className={styles.channelList}>
              {channels.map((channel) => (
                <li key={channel.id} className={styles.channelRow}>
                  <span
                    className={ui.dot}
                    data-tone={
                      !channel.enabled ? undefined : channel.key_count > 0 ? 'success' : 'warning'
                    }
                  />
                  <span className={styles.channelName} title={channel.name}>
                    {channel.name}
                  </span>
                  <Tag tone={channel.tier === 'paid' ? 'brand' : 'neutral'}>
                    {channel.tier === 'paid' ? copy.channels.tierPaid : copy.channels.tierFree}
                  </Tag>
                  <span className={styles.channelKeys}>
                    {channel.key_count > 0
                      ? `${channel.key_count} Key`
                      : copy.dashboard.channelNoKeys}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
