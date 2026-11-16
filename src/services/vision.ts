import { ApiError, apiUrl, request } from './api/client.js'

/** POST /api/vision/describe 的成功响应，字段见 server/src/routes/vision.ts */
export type VisionDescription = {
  /** 视觉模型给出的自然语言描述 */
  description: string
  /** 实际执行转述的公开模型 id；用于打标「已由 <模型> 转述」 */
  model: string
}

type DescribeResponse = { ray?: string; description?: unknown; model?: unknown }

/**
 * 让服务端的视觉模型转述一张已上传的图片（fileId 就是 /api/files 返回的 sha256）。
 *
 * 复用 api/client 的 request：非 2xx 会抛 ApiError，message 是后端原文（已带请求编号 ray），
 * 由调用方决定怎么展示；这里不吞掉错误，也不自己拼文案。
 */
export const describeImage = async (
  fileId: string,
  question?: string
): Promise<VisionDescription> => {
  const response = await request(apiUrl('/vision/describe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // question 为空时不传，服务端会用自己的默认描述提示词
    body: JSON.stringify(question ? { file_id: fileId, question } : { file_id: fileId }),
  })

  const body = (await response.json()) as DescribeResponse
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (description === '') {
    // 协议层问题（不是 2xx 错误），文案交给界面按当前语言展示
    throw new ApiError('protocol', { key: 'visionDescribeEmpty' })
  }
  return {
    description,
    model: typeof body.model === 'string' ? body.model : '',
  }
}
