import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '../../components/base/Button.js'
import { showToast } from '../../components/base/toastState.js'
import { api, errorMessage, type SystemInfo } from '../api.js'
import { Card } from '../components/Card.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { DataTable, type DataTableColumn } from '../components/DataTable.js'
import { ErrorState } from '../components/EmptyState.js'
import { PageHeader } from '../components/PageHeader.js'
import { Skeleton } from '../components/Skeleton.js'
import { copy } from '../copy.js'
import { formatBytes, formatNumber } from '../format.js'
import ui from '../components/ui.module.css'
import styles from './System.module.css'

type TableRow = { name: string; rows: number }

const tableColumns: DataTableColumn<TableRow>[] = [
  {
    key: 'name',
    title: copy.system.tableName,
    render: (row) => <span className={ui.mono}>{row.name}</span>,
  },
  {
    key: 'rows',
    title: copy.system.tableRows,
    align: 'end',
    width: '120px',
    render: (row) => <span className={ui.mono}>{formatNumber(row.rows)}</span>,
  },
]

const InfoRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.infoRow}>
    <span className={ui.caption}>{label}</span>
    <span className={styles.infoValue}>{children}</span>
  </div>
)

type CleanupResult = { removed: number; freed_bytes: number }

/** 系统页：磁盘/文件/表行数 + 孤儿文件清理 */
export const System = () => {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [result, setResult] = useState<CleanupResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.system.info()
      setInfo({ db: response.db, files: response.files, tables: response.tables })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const cleanup = async () => {
    setCleaning(true)
    try {
      const response = await api.system.cleanup()
      setResult({ removed: response.removed, freed_bytes: response.freed_bytes })
      showToast(copy.system.cleanupDone(response.removed, formatBytes(response.freed_bytes)))
      setConfirming(false)
      await load()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setCleaning(false)
    }
  }

  return (
    <>
      <PageHeader
        title={copy.system.title}
        description={copy.system.description}
        actions={
          <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
            {copy.common.refresh}
          </Button>
        }
      />

      {error && !info ? (
        <Card>
          <ErrorState message={error} onRetry={() => void load()} />
        </Card>
      ) : (
        <>
          <div className={styles.cards}>
            <Card title={copy.system.db}>
              <div className={styles.infoList}>
                <InfoRow label={copy.system.dbPath}>
                  {info ? (
                    <span className={styles.path} title={info.db.path}>
                      {info.db.path}
                    </span>
                  ) : (
                    <Skeleton width="70%" />
                  )}
                </InfoRow>
                <InfoRow label={copy.system.dbSize}>
                  {info ? (
                    <span className={ui.mono}>{formatBytes(info.db.size_bytes)}</span>
                  ) : (
                    <Skeleton width="60px" />
                  )}
                </InfoRow>
                <InfoRow label={copy.system.dbWal}>
                  {info ? (
                    <span className={ui.mono}>{formatBytes(info.db.wal_bytes)}</span>
                  ) : (
                    <Skeleton width="60px" />
                  )}
                </InfoRow>
              </div>
            </Card>

            <Card title={copy.system.files}>
              <div className={styles.infoList}>
                <InfoRow label={copy.system.filesDir}>
                  {info ? (
                    <span className={styles.path} title={info.files.dir}>
                      {info.files.dir}
                    </span>
                  ) : (
                    <Skeleton width="70%" />
                  )}
                </InfoRow>
                <InfoRow label={copy.system.fileCount}>
                  {info ? (
                    <span className={ui.mono}>{formatNumber(info.files.count)}</span>
                  ) : (
                    <Skeleton width="60px" />
                  )}
                </InfoRow>
                <InfoRow label={copy.system.fileBytes}>
                  {info ? (
                    <span className={ui.mono}>{formatBytes(info.files.bytes)}</span>
                  ) : (
                    <Skeleton width="60px" />
                  )}
                </InfoRow>
              </div>
            </Card>
          </div>

          <Card flush title={copy.system.tables}>
            <DataTable
              columns={tableColumns}
              rows={info?.tables ?? []}
              rowKey={(row) => row.name}
              loading={loading && !info}
              skeletonRows={4}
              fixed
            />
          </Card>

          <Card
            title={copy.system.cleanup}
            description={copy.system.cleanupDescription}
            actions={
              <Button
                variant="dangerOutlined"
                size="m"
                disabled={cleaning}
                onClick={() => setConfirming(true)}
              >
                {copy.system.cleanupAction}
              </Button>
            }
          >
            <div className={styles.cleanup}>
              <div className={ui.caption}>{copy.system.lastCleanup}</div>
              {result ? (
                <div className={styles.cleanupResult}>
                  {copy.system.cleanupDone(result.removed, formatBytes(result.freed_bytes))}
                </div>
              ) : (
                <div className={ui.caption}>{copy.system.noCleanup}</div>
              )}
            </div>
          </Card>
        </>
      )}

      {confirming ? (
        <ConfirmDialog
          title={copy.system.cleanupConfirmTitle}
          description={copy.system.cleanupConfirmBody}
          confirmLabel={copy.system.cleanupConfirmAction}
          pendingLabel={copy.system.cleanupPending}
          danger
          busy={cleaning}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void cleanup()}
        />
      ) : null}
    </>
  )
}
