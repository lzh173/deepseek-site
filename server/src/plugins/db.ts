import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type { Db } from '../db/index.ts'

/** 把 better-sqlite3 实例挂到 app.db，全应用共用。 */
export const dbPlugin = fp((app: FastifyInstance, opts: { db: Db }, done: () => void) => {
  app.decorate('db', opts.db)
  app.addHook('onClose', async () => {
    opts.db.close()
  })
  done()
})
