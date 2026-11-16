import { create } from 'zustand'
import { apiUrl, request } from './api/client.js'
import { useSettings } from './settings.js'

/** 模型能力位；false 表示该能力不可用，对应界面开关要隐藏（不是置灰） */
export type ModelCaps = {
  vision: boolean
  reasoning: boolean
  web_search: boolean
  read_url: boolean
  file_parse: boolean
}

export type ModelTier = 'free' | 'paid'

/** GET /api/models 返回的单条模型信息，字段见 GOAL.md §6.2 */
export type ChatModelInfo = {
  id: string
  display_name: string
  tier: ModelTier
  /** 服务端按授权 Key 的实时状态计算；false 仍可列出，但请求会 503 */
  available: boolean
  context: number
  caps: ModelCaps
}

type ModelsResponse = { ray?: string; models?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** 只有显式 false 才算不支持：字段缺失时按支持处理，避免界面开关整片消失 */
const readCaps = (value: unknown): ModelCaps => {
  const caps = isRecord(value) ? value : {}
  return {
    vision: caps.vision !== false,
    reasoning: caps.reasoning !== false,
    web_search: caps.web_search !== false,
    read_url: caps.read_url !== false,
    file_parse: caps.file_parse !== false,
  }
}

const readModel = (value: unknown): ChatModelInfo | null => {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null
  }
  return {
    id: value.id,
    display_name: typeof value.display_name === 'string' ? value.display_name : value.id,
    tier: value.tier === 'paid' ? 'paid' : 'free',
    available: value.available !== false,
    context: typeof value.context === 'number' ? value.context : 0,
    caps: readCaps(value.caps),
  }
}

/** GET /api/models（需登录）；未登录会抛 401 的 ApiError */
export const fetchModels = async (signal?: AbortSignal): Promise<ChatModelInfo[]> => {
  const response = await request(apiUrl('/models'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  const body = (await response.json()) as ModelsResponse
  const list = Array.isArray(body.models) ? body.models : []
  return list.flatMap((item) => {
    const model = readModel(item)
    return model ? [model] : []
  })
}

type ModelsState = {
  models: ChatModelInfo[]
  status: 'idle' | 'loading' | 'ready' | 'error'
}

export const useModels = create<ModelsState>(() => ({ models: [], status: 'idle' }))

let loading: Promise<void> | undefined

/** 拉取一次模型列表；并发调用共用同一个请求，失败时保留上一次结果 */
export const loadModels = (): Promise<void> => {
  if (loading) {
    return loading
  }
  useModels.setState({ status: 'loading' })
  loading = fetchModels()
    .then((models) => {
      useModels.setState({ models, status: 'ready' })
    })
    .catch(() => {
      useModels.setState({ status: 'error' })
    })
    .finally(() => {
      loading = undefined
    })
  return loading
}

/** 当前使用的模型：优先用户选择，其次列表里第一个可用模型，最后退回第一个 */
const pickModelId = (model: string | null, models: ChatModelInfo[]): string => {
  const selected = models.find((item) => item.id === model)
  if (model && (selected || models.length === 0)) {
    return model
  }
  return (models.find((item) => item.available) ?? models[0])?.id ?? ''
}

/** 当前使用的模型 id（非 React 环境用，如请求前读取） */
export const currentModelId = (): string => {
  const id = pickModelId(useSettings.getState().model, useModels.getState().models)
  if (!id) {
    // 列表还没拿到（或上次失败）：后台补拉一次，下一次发送就能带上模型
    void loadModels()
  }
  return id
}

/** 当前模型的能力位；模型列表还没拿到时返回 null，调用方按「未知」处理（不隐藏开关） */
export const currentModelCaps = (): ModelCaps | null => {
  const id = currentModelId()
  return useModels.getState().models.find((item) => item.id === id)?.caps ?? null
}

/** 组件里订阅当前模型的能力位；列表未就绪时为 null（开关照常显示） */
export const useCurrentModelCaps = (): ModelCaps | null => {
  const model = useSettings((state) => state.model)
  const models = useModels((state) => state.models)
  const id = pickModelId(model, models)
  return models.find((item) => item.id === id)?.caps ?? null
}

/** 组件里订阅当前模型信息（设置里展示下拉与 context 说明用） */
export const useCurrentModel = (): ChatModelInfo | null => {
  const model = useSettings((state) => state.model)
  const models = useModels((state) => state.models)
  const id = pickModelId(model, models)
  return models.find((item) => item.id === id) ?? null
}
