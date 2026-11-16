import type { FastifyInstance } from 'fastify'
import { reviveCoolingKeys } from '../pool/index.ts'

/**
 * 定时任务。目前只有一条：把冷却到期的 Key 拉回 active。
 * 孤儿文件清理在管理端手动触发（POST /api/admin/system/cleanup）。
 */
export const startJobs = (app: FastifyInstance): void => {
  const timer = setInterval(() => {
    try {
      reviveCoolingKeys(app)
    } catch (error) {
      app.log.error({ err: error }, 'revive cooling keys failed')
    }
  }, 60_000)

  // 不阻塞进程退出
  timer.unref()

  app.addHook('onClose', async () => {
    clearInterval(timer)
  })
}
