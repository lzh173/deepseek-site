import clsx from 'clsx'
import { Fragment, type KeyboardEvent, type ReactNode } from 'react'
import { EmptyState } from './EmptyState.js'
import { Skeleton } from './Skeleton.js'
import styles from './DataTable.module.css'

export type DataTableColumn<T> = {
  /** 列的稳定标识，同时用作 <th>/<td> 的 key */
  key: string
  title: ReactNode
  /** 例如 '160px'、'28%'，交给 <colgroup> 控制 */
  width?: string
  align?: 'start' | 'center' | 'end'
  render: (row: T) => ReactNode
}

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** 首次加载显示骨架行；已有数据时只做半透明禁用，避免闪一下空白 */
  loading?: boolean
  skeletonRows?: number
  emptyTitle?: ReactNode
  emptyHint?: ReactNode
  emptyAction?: ReactNode
  onRowClick?: (row: T) => void
  /** 与 rowKey 对应，用于高亮当前选中行 */
  selectedKey?: string | null
  /** 展开行：renderExpanded 返回的内容占满一整行 */
  expandedKey?: string | null
  renderExpanded?: (row: T) => ReactNode
  /** 固定表格布局：列宽严格按 width，剩余列吃掉剩余宽度，配合省略号用 */
  fixed?: boolean
  className?: string
}

/**
 * 通用表格。只管排版与三种状态（骨架 / 空 / 数据），
 * 业务列的渲染交给各页面，避免为了"通用"把业务塞进组件。
 */
export const DataTable = <T,>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 3,
  emptyTitle,
  emptyHint,
  emptyAction,
  onRowClick,
  selectedKey,
  expandedKey,
  renderExpanded,
  fixed = false,
  className,
}: DataTableProps<T>) => {
  const showSkeleton = loading && rows.length === 0
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick) {
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onRowClick(row)
    }
  }

  return (
    <div className={clsx(styles.wrap, className, loading && rows.length > 0 && styles.refreshing)}>
      <table className={clsx(styles.table, fixed && styles.fixed)}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={styles.headCell} data-align={column.align}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {showSkeleton
            ? Array.from({ length: skeletonRows }, (_, index) => (
                <tr key={`skeleton-${index}`}>
                  {columns.map((column, columnIndex) => (
                    <td key={column.key} className={styles.cell} data-align={column.align}>
                      <Skeleton width={columnIndex === 0 ? '40%' : '70%'} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => {
                const key = rowKey(row)
                const expanded =
                  expandedKey !== null && expandedKey === key && Boolean(renderExpanded)
                return (
                  <Fragment key={key}>
                    <tr
                      className={clsx(
                        styles.bodyRow,
                        onRowClick && styles.clickable,
                        selectedKey !== null && selectedKey === key && styles.selected
                      )}
                      tabIndex={onRowClick ? 0 : undefined}
                      aria-selected={selectedKey !== null ? selectedKey === key : undefined}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      onKeyDown={(event) => onKeyDown(event, row)}
                    >
                      {columns.map((column) => (
                        <td key={column.key} className={styles.cell} data-align={column.align}>
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>
                    {expanded ? (
                      <tr>
                        <td className={styles.expandedCell} colSpan={columns.length}>
                          {renderExpanded ? renderExpanded(row) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
          {!showSkeleton && rows.length === 0 ? (
            <tr>
              <td className={styles.stateCell} colSpan={columns.length}>
                <EmptyState title={emptyTitle} hint={emptyHint} action={emptyAction} />
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
