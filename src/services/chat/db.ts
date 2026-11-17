/**
 * 会话与附件的存储层：服务端是唯一真源（GOAL.md A-04），这里整体由 IndexedDB 改为 HTTP。
 *
 * 导出签名与 IndexedDB 版本保持一致，上层 `store.ts` 与历史导入导出无需感知差别。
 * 后端契约（server/src/routes/sessions.ts、files.ts）：
 *   GET    /api/sessions         → { ray, sessions: [{ id, title, created_at, updated_at }] }
 *   GET    /api/sessions/:id     → { ray, session: { id, title, created_at, updated_at, payload } }
 *                                  payload 是整棵 Session 树的 JSON 字符串；不存在时 404
 *   PUT    /api/sessions/:id     → body { title?, payload }，upsert
 *   PATCH  /api/sessions/:id     → body { title }，只改标题
 *   DELETE /api/sessions/:id     → { ok, deleted }，幂等
 *   POST   /api/files            → multipart 字段 file（可选 purpose），返回 FileObject
 *   GET    /api/files/:id        → 文件原始字节
 *   DELETE /api/files/:id        → 204
 * 时间戳以服务端 ISO 字符串为准（前端用毫秒数展示）；标题也以库里的这一行为准，
 * 因为 PATCH 只改标题列、不会改写 payload 里的旧标题。
 *
 * 附件原件：会话里只保存元数据与 serverId，原件本身按附件本地 id 上传到 /api/files，
 * 本地 id → 服务端 file_id 的映射写进 localStorage，刷新后仍能取回缩略图与补传用的原件。
 *
 * TODO(导入导出)：历史导入仍在浏览器里解析 ZIP，但「原子替换整库」在服务端还没有对应接口。
 * 暂存因此退化为**内存**（页面刷新即丢失），`commitStaging` 用「先 PUT 暂存会话、再删除多余会话」
 * 尽力而为，失败时会留下部分已写入的会话——导入导出功能待后端支持（需要事务化的批量导入接口）。
 */
import { ApiError, apiUrl, downloadFile, request, uploadFile } from '../api/client.js'
import type { FilePurpose } from '../api/types.js'
import { toSessionSummary, type Message, type Session, type SessionSummary } from './types.js'

/** 流式回复期间 saveSession 会被频繁调用：300ms 内的多次调用合并成一次 PUT */
const SAVE_DEBOUNCE_MS = 300

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 本地附件 id → 服务端 file_id，存 localStorage 以便刷新后仍能取回原件 */
const FILE_IDS_KEY = 'chat-demo:file-ids'

const fileIds = new Map<string, string>()
let fileIdsLoaded = false
/** 本次页面已取回的原件；缩略图反复渲染时不再重复下载 */
const blobs = new Map<string, Blob>()

const loadFileIds = () => {
  if (fileIdsLoaded) {
    return
  }
  fileIdsLoaded = true
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FILE_IDS_KEY) ?? '{}')
    if (typeof raw === 'object' && raw !== null) {
      for (const [localId, serverId] of Object.entries(raw)) {
        if (typeof serverId === 'string') {
          fileIds.set(localId, serverId)
        }
      }
    }
  } catch {
    // 映射损坏时按「没有原件」处理，重新上传即可恢复
  }
}

const writeFileIds = () => {
  try {
    localStorage.setItem(FILE_IDS_KEY, JSON.stringify(Object.fromEntries(fileIds)))
  } catch {
    // 存储不可用时只在本次页面内有效
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('服务器返回的不是 JSON')
  }
}

/** 服务端 ISO 时间 → 毫秒数；缺失或非法时归零 */
const readTime = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isNaN(time) ? 0 : time
  }
  return 0
}

const sessionUrl = (id: string) => apiUrl(`/sessions/${encodeURIComponent(id)}`)

/** 列表项是 { id, title, created_at, updated_at }；服务端按 updated_at 倒序返回 */
const readSummaries = (body: unknown): SessionSummary[] => {
  const list = isRecord(body) && Array.isArray(body.sessions) ? body.sessions : []
  return list.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') {
      return []
    }
    return [
      {
        id: item.id,
        title: typeof item.title === 'string' ? item.title : '',
        createdAt: readTime(item.created_at),
        updatedAt: readTime(item.updated_at),
      },
    ]
  })
}

/** 详情：会话树在 payload 字符串里，标题与时间是库里的这一行 */
const readSession = (body: unknown): Session | undefined => {
  const detail = isRecord(body) && isRecord(body.session) ? body.session : null
  if (!detail || typeof detail.id !== 'string' || typeof detail.payload !== 'string') {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(detail.payload)
  } catch {
    throw new Error('服务器返回的会话数据不是合法的 JSON')
  }
  const tree = isRecord(parsed) ? parsed : {}
  const session: Session = {
    id: detail.id,
    title: typeof detail.title === 'string' ? detail.title : '',
    createdAt: readTime(detail.created_at),
    updatedAt: readTime(detail.updated_at),
    messages: Array.isArray(tree.messages) ? (tree.messages as Message[]) : [],
  }
  if (typeof tree.rootMessageId === 'string' || tree.rootMessageId === null) {
    session.rootMessageId = tree.rootMessageId
  }
  return session
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const response = await request(apiUrl('/sessions'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  return readSummaries(await readJson(response)).map(toSessionSummary)
}

/** 会话详情；服务端没有该会话（404）时返回 undefined，其余错误照常抛出 */
export const loadSession = async (id: string): Promise<Session | undefined> => {
  let response: Response
  try {
    response = await request(sessionUrl(id), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return undefined
    }
    throw error
  }
  return readSession(await readJson(response))
}

/** PUT 的 body 是 { title?, payload }，会话树整棵字符串化后放进 payload */
const putSession = async (session: Session): Promise<void> => {
  await request(sessionUrl(session.id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ title: session.title, payload: JSON.stringify(session) }),
  })
}

type SaveWaiter = { resolve: () => void; reject: (error: unknown) => void }

type PendingSave = {
  /** 合并期间最后一次写入的会话快照 */
  session: Session
  files: Map<string, StoredFile>
  waiters: SaveWaiter[]
  timer: ReturnType<typeof setTimeout>
}

const pendingSaves = new Map<string, PendingSave>()

/** 上传单个原件并记住本地 id → 服务端 file_id；已上传过的直接复用 */
const rememberFile = async (file: StoredFile): Promise<string> => {
  blobs.set(file.id, file.blob)
  loadFileIds()
  const known = fileIds.get(file.id)
  if (known) {
    return known
  }
  const body =
    file.blob instanceof File ? file.blob : new File([file.blob], file.id, { type: file.blob.type })
  const purpose: FilePurpose | null = file.blob.type.startsWith('image/') ? null : 'user_data'
  const object = await uploadFile(body, purpose)
  registerFileId(file.id, object.id)
  return object.id
}

/**
 * 附件走 /api/files 上传后登记映射：本地 id → 服务端 file_id。
 * 这样会话落盘时不必把同一份原件再传一遍，缩略图与补传也能直接复用。
 */
export const registerFileId = (localId: string, serverId: string): void => {
  loadFileIds()
  if (fileIds.get(localId) === serverId) {
    return
  }
  fileIds.set(localId, serverId)
  writeFileIds()
}

/** 退出登录时清掉本地原件映射：服务端 file_id 属于上一个账号，留着只会得到 404 */
export const clearLocalFileCache = (): void => {
  fileIds.clear()
  blobs.clear()
  fileIdsLoaded = true
  try {
    localStorage.removeItem(FILE_IDS_KEY)
  } catch {
    // 存储不可用时无需清理
  }
}

const uploadOriginals = async (files: Iterable<StoredFile>): Promise<void> => {
  // 一张图传失败不该让整条回复的落盘失败：附件本身还有 serverId 可用，原件只影响缩略图
  const results = await Promise.allSettled([...files].map(rememberFile))
  for (const result of results) {
    if (result.status === 'rejected') {
      reportStorageError('upload file original')(result.reason)
    }
  }
}

const flushSave = async (id: string): Promise<void> => {
  const pending = pendingSaves.get(id)
  if (!pending) {
    return
  }
  pendingSaves.delete(id)
  clearTimeout(pending.timer)
  try {
    await uploadOriginals(pending.files.values())
    await putSession(pending.session)
    for (const waiter of pending.waiters) {
      waiter.resolve()
    }
  } catch (error) {
    for (const waiter of pending.waiters) {
      waiter.reject(error)
    }
  }
}

/** 删除会话前丢弃尚未发出的保存，否则滞后 300ms 的 PUT 会把刚删掉的会话写回来 */
const cancelPendingSave = (id: string) => {
  const pending = pendingSaves.get(id)
  if (!pending) {
    return
  }
  pendingSaves.delete(id)
  clearTimeout(pending.timer)
  for (const waiter of pending.waiters) {
    waiter.resolve()
  }
}

/**
 * 写入会话：300ms 内对同一会话的多次调用合并成一次，流式回复不会打出上百个请求。
 * 返回的 Promise 在该会话真正落盘（或合并后的写入失败）时结算，调用方据此清除「未保存」标记。
 */
export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    const waiter: SaveWaiter = { resolve, reject }
    const queued = pendingSaves.get(session.id)
    if (queued) {
      clearTimeout(queued.timer)
      queued.session = session
      for (const file of files) {
        queued.files.set(file.id, file)
      }
      queued.waiters.push(waiter)
      queued.timer = setTimeout(() => void flushSave(session.id), SAVE_DEBOUNCE_MS)
      return
    }
    const pending: PendingSave = {
      session,
      files: new Map(files.map((file) => [file.id, file] as const)),
      waiters: [waiter],
      timer: setTimeout(() => void flushSave(session.id), SAVE_DEBOUNCE_MS),
    }
    pendingSaves.set(session.id, pending)
  })

/** 立即写出所有待保存的会话（页面隐藏、关闭前调用，尽量不丢最后一次修改） */
export const flushSaves = async (): Promise<void> => {
  await Promise.all([...pendingSaves.keys()].map(flushSave))
}

/** 未打开的会话也可重命名，只改标题 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  // 先把待写的会话发出去，再改标题，避免滞后的 PUT 把新标题覆盖回去
  await flushSave(id)
  await request(sessionUrl(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ title }),
  })
}

/** 删除会话；服务端负责同步清理附件引用，这里不再维护本地引用计数 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  cancelPendingSave(sessionId)
  await request(sessionUrl(sessionId), { method: 'DELETE' })
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    blobs.set(file.id, file.blob)
  }
  await uploadOriginals(files)
}

/** 取回原件：优先本次页面的缓存，其次按映射从服务端下载；没有原件时返回 undefined */
export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const cached = blobs.get(id)
  if (cached) {
    return cached
  }
  loadFileIds()
  const serverId = fileIds.get(id)
  if (!serverId) {
    return undefined
  }
  try {
    const blob = await downloadFile(serverId)
    blobs.set(id, blob)
    return blob
  } catch (error) {
    reportStorageError('download file original')(error)
    return undefined
  }
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/** 导入暂存只在内存里：页面刷新即丢弃，见文件头的导入导出 TODO */
const stagingSessions = new Map<string, Session>()
const stagingFiles = new Map<string, StoredFile>()

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  stagingSessions.clear()
  stagingFiles.clear()
}

export const addStagingSession = async (session: Session): Promise<void> => {
  stagingSessions.set(session.id, session)
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    stagingFiles.set(file.id, file)
  }
}

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  for (const session of stagingSessions.values()) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        file.mimeType = types.get(file.id) ?? ''
      }
    }
  }
}

/**
 * 导入完成后用暂存替换正式数据。
 * 没有服务端事务可用，只能尽力而为：先写暂存会话（失败则不动现有数据），再删除不在暂存里的旧会话。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const staged = [...stagingSessions.values()]
  await saveFiles([...stagingFiles.values()])
  const existing = await loadSessionSummaries()
  for (const session of staged) {
    await putSession(session)
  }
  const keep = new Set(staged.map((session) => session.id))
  for (const summary of existing) {
    if (!keep.has(summary.id)) {
      await deleteSession(summary.id)
    }
  }
  const summaries = staged.map(toSessionSummary)
  await clearStaging()
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}
