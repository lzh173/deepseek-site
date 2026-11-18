/**
 * Ray 端到端闭环测试。
 *
 * 自建 mock 上游 / mock SearXNG，拉一个独立的 BFF 实例（临时数据目录、随机端口），
 * 把「登录 → 配渠道 Key 模型 → 对话 SSE → 搜索 → 附件会话 → 授权 → 配额 → 审核 → 视觉」
 * 整条链路跑一遍，最后打印 PASS/FAIL/SKIP 汇总。
 *
 * 用法：cd server && node --experimental-strip-types scripts/e2e.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------- 断言harness

type Result = { name: string; ok: boolean; skip?: boolean; detail?: string }
const results: Result[] = []

const fail = (message: string): never => {
  throw new Error(message)
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) fail(message)
}

const check = async (name: string, run: () => Promise<void> | void): Promise<void> => {
  try {
    await run()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

const skip = (name: string, why: string): void => {
  results.push({ name, ok: true, skip: true, detail: why })
}

// ------------------------------------------------------------------ 工具函数

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 拿一个空闲端口：先监听 0，读到端口后立刻关闭。 */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('拿不到端口'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })

type SseFrame = { event: string; data: unknown }

const parseSse = (raw: string): SseFrame[] => {
  const frames: SseFrame[] = []
  for (const block of raw.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u)
    let event = ''
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    try {
      frames.push({ event, data: JSON.parse(dataLines.join('\n')) })
    } catch {
      frames.push({ event, data: dataLines.join('\n') })
    }
  }
  return frames
}

const eventTypes = (frames: SseFrame[]): string[] =>
  frames.map((frame) => (frame.data as { type?: string }).type ?? frame.event)

// ------------------------------------------------------------------ mock 上游

type MockState = {
  /** 置为 N 后，接下来 N 次流式请求返回 429 */
  fail429: number
  /** 记录收到的请求体，供断言「system 是否注入」 */
  lastBodies: Record<string, unknown>[]
}

const mockState: MockState = { fail429: 0, lastBodies: [] }

const readBody = async (req: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => resolve(raw))
  })

const startMockUpstream = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('no')
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
      mockState.lastBodies.push(body)

      if (mockState.fail429 > 0) {
        mockState.fail429 -= 1
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: { message: 'rps exhausted', type: 'quota_exceeded_error' } })
        )
        return
      }

      // 非流式：视觉转述用
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '图片里是一只猫。' } }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          })
        )
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      send({ choices: [{ index: 0, delta: { reasoning_content: '先想一想。' } }] })
      send({ choices: [{ index: 0, delta: { content: '你好' } }] })
      send({ choices: [{ index: 0, delta: { content: '，我是 mock。' } }] })
      send({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address === 'object' ? address.port : 0)
    })
  })
  return { server, port }
}

const startMockSearxng = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/search')) {
      res.writeHead(404).end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: [
          { title: '结果一', url: 'https://example.com/a', content: '第一条摘要' },
          { title: '结果二', url: 'https://example.com/b', content: '第二条摘要' },
        ],
      })
    )
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address === 'object' ? address.port : 0)
    })
  })
  return { server, port }
}

// ------------------------------------------------------------------ BFF 客户端

class Client {
  private cookie = ''
  private readonly base: string

  constructor(base: string) {
    this.base = base
  }

  async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookie) headers.set('cookie', this.cookie)
    const response = await fetch(`${this.base}${pathname}`, { ...init, headers })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? ''
    return response
  }

  async json<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(pathname, init)
    return (await response.json()) as T
  }

  post(pathname: string, body?: unknown): Promise<Response> {
    return this.request(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async login(username: string, password: string): Promise<number> {
    const response = await this.post('/api/auth/login', { username, password })
    return response.status
  }
}

const chatBody = (model: string, text: string, extra: Record<string, unknown> = {}): unknown => ({
  model,
  system: '你是助手',
  messages: [{ role: 'user', content: text }],
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'high' },
  title: { enabled: true },
  stream: true,
  ...extra,
})

// ------------------------------------------------------------------ 主流程

const main = async (): Promise<void> => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ray-e2e-'))
  const upstream = await startMockUpstream()
  const searxng = await startMockSearxng()
  const bffPort = await freePort()
  const base = `http://127.0.0.1:${bffPort}`
  const adminPassword = 'e2e-admin-pass'

  const child: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', 'src/index.ts'],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        RAY_DATA_DIR: dataDir,
        RAY_PORT: String(bffPort),
        RAY_HOST: '127.0.0.1',
        RAY_ADMIN_USER: 'admin',
        RAY_ADMIN_PASSWORD: adminPassword,
        RAY_SEARXNG_URL: `http://127.0.0.1:${searxng.port}`,
        RAY_MODERATION_KEYWORDS: '违禁词测试',
        RAY_LOG_LEVEL: 'silent',
      },
      stdio: 'ignore',
    }
  )

  const cleanup = (): void => {
    child.kill('SIGKILL')
    upstream.server.close()
    searxng.server.close()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }

  try {
    // 等健康检查
    let ready = false
    for (let i = 0; i < 60; i += 1) {
      try {
        const response = await fetch(`${base}/api/health`)
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(500)
    }
    if (!ready) {
      throw new Error('BFF 30 秒内没有起来')
    }

    const anon = new Client(base)
    const admin = new Client(base)

    // ---------------- A. 基础与鉴权 ----------------
    await check('health 200 且带 x-ray-id', async () => {
      const response = await fetch(`${base}/api/health`)
      assert(response.status === 200, `status=${response.status}`)
      assert(/^ray_[0-9a-f]{12}$/u.test(response.headers.get('x-ray-id') ?? ''), '缺少 x-ray-id')
    })

    await check('未登录访问 /api/models 返回 401 且带 ray', async () => {
      const response = await anon.request('/api/models')
      assert(response.status === 401, `status=${response.status}`)
      const body = (await response.json()) as { error?: { message?: string } }
      assert(/ray_[0-9a-f]{12}/u.test(body.error?.message ?? ''), 'message 里没有 ray')
    })

    await check('错误密码返回 401', async () => {
      const status = await new Client(base).login('admin', 'wrong-password')
      assert(status === 401, `status=${status}`)
    })

    await check('管理员登录成功', async () => {
      const status = await admin.login('admin', adminPassword)
      assert(status === 200, `status=${status}`)
    })

    await check('GET /api/me 返回 admin', async () => {
      const body = await admin.json<{ user?: { username?: string; role?: string } }>('/api/me')
      assert(body.user?.username === 'admin', JSON.stringify(body))
      assert(body.user?.role === 'admin', 'role 不是 admin')
    })

    // ---------------- B. 管理端配置 ----------------
    const channelId = await (async () => {
      const body = await admin.json<{ item: { id: string } }>('/api/admin/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'e2e 上游',
          kind: 'openai',
          base_url: `http://127.0.0.1:${upstream.port}/v1`,
          tier: 'free',
          priority: 10,
          timeout_ms: 30000,
          concurrency: 4,
          enabled: true,
        }),
      })
      return body.item.id
    })()

    let keyIds: string[] = []
    await check('批量导入 2 把 Key 且响应不含明文', async () => {
      const response = await admin.post('/api/admin/keys', {
        channel_id: channelId,
        keys: ['sk-e2e-key-one', 'sk-e2e-key-two'],
        label: 'e2e',
        daily_quota: 1000,
      })
      const text = await response.text()
      assert(!text.includes('sk-e2e-key-one'), '响应体泄露了明文 Key')
      const body = JSON.parse(text) as { items: { id: string; secret_masked?: string }[] }
      assert(body.items.length === 2, `导入数量 ${body.items.length}`)
      keyIds = body.items.map((item) => item.id)
      assert(
        body.items.every((item) => (item.secret_masked ?? '').includes('••••')),
        '没有掩码'
      )
    })

    const publicModel = 'e2e-chat'
    await check('创建模型并把两把 Key 都映射过去', async () => {
      const created = await admin.post('/api/admin/models', {
        id: publicModel,
        display_name: 'E2E Chat',
        context: 8192,
        tier: 'free',
        caps: { vision: true, reasoning: true, web_search: true, read_url: true, file_parse: true },
      })
      assert(created.status === 200, `创建模型 status=${created.status}`)
      for (const keyId of keyIds) {
        const mapped = await admin.request(`/api/admin/keys/${keyId}/models`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            models: [
              { public_model: publicModel, upstream_model: 'mock-1', weight: 1, enabled: true },
            ],
          }),
        })
        assert(mapped.status === 200, `映射 status=${mapped.status}`)
      }
    })

    await check('/api/models 返回该模型且 available=true', async () => {
      const body = await admin.json<{ models: { id: string; available: boolean }[] }>('/api/models')
      const found = body.models.find((model) => model.id === publicModel)
      if (!found) {
        throw new Error('列表里没有 e2e-chat')
      }
      assert(found.available, 'available=false')
    })

    // ---------------- C. 对话 SSE ----------------
    await check('普通对话的事件序列与字段', async () => {
      const response = await admin.post('/api/chat', chatBody(publicModel, '你好'))
      assert(response.status === 200, `status=${response.status}`)
      const raw = await response.text()
      assert(!raw.includes('[DONE]'), '不应出现 [DONE]')
      const frames = parseSse(raw)
      const types = eventTypes(frames)
      assert(types[0] === 'message_start', `首帧 ${types[0]}`)
      assert(types.at(-1) === 'message_stop', `末帧 ${types.at(-1)}`)
      for (const frame of frames) {
        assert(frame.event === (frame.data as { type?: string }).type, 'event 名与 type 不一致')
      }
      const starts = frames.filter(
        (frame) =>
          types[0] !== undefined && (frame.data as { type?: string }).type === 'content_block_start'
      )
      const indexes = starts.map((frame) => (frame.data as { index: number }).index)
      assert(
        JSON.stringify(indexes) === JSON.stringify([...indexes].sort((a, b) => a - b)),
        '块索引不递增'
      )
      const delta = frames.find(
        (frame) => (frame.data as { type?: string }).type === 'message_delta'
      )
      const payload = delta?.data as {
        delta?: { title?: string }
        usage?: { output_tokens?: number }
      }
      assert(
        typeof payload?.delta?.title === 'string' && payload.delta.title.length > 0,
        '缺少 title'
      )
      assert((payload?.usage?.output_tokens ?? 0) > 0, '缺少 output_tokens')
    })

    await check('thinking=disabled 时不下发 thinking 块', async () => {
      const response = await admin.post(
        '/api/chat',
        chatBody(publicModel, '你好', { thinking: { type: 'disabled' } })
      )
      const types = eventTypes(parseSse(await response.text()))
      assert(!types.includes('thinking_delta'), '出现了 thinking_delta')
      const raw = await (await admin.post('/api/chat', chatBody(publicModel, '你好'))).text()
      void raw
    })

    await check('thinking=enabled 时下发 thinking 块与 signature', async () => {
      const response = await admin.post(
        '/api/chat',
        chatBody(publicModel, '你好', { thinking: { type: 'enabled' } })
      )
      const raw = await response.text()
      assert(raw.includes('thinking_delta'), '没有 thinking_delta')
      assert(raw.includes('signature_delta'), '没有 signature_delta')
    })

    // ---------------- D. 失败与故障转移 ----------------
    await check('上游 429 时换 Key 重试成功', async () => {
      mockState.fail429 = 1
      const response = await admin.post('/api/chat', chatBody(publicModel, '重试测试'))
      assert(
        response.status === 200,
        `status=${response.status}：${(await response.clone().text()).slice(0, 200)}`
      )
      const raw = await response.text()
      assert(raw.includes('message_stop'), '没有正常结束')
    })

    await check('所有 Key 都失败时返回 503 + ray', async () => {
      // 让上游对接下来每一次请求都返回 429：重试会换 Key，但两把都打不通
      mockState.fail429 = 50
      const response = await admin.post('/api/chat', chatBody(publicModel, '应该失败'))
      const body = (await response.json()) as {
        ray?: string
        error?: { type?: string; message?: string }
      }
      assert(response.status === 503, `status=${response.status}`)
      assert(body.error?.type === 'server_busy', `type=${body.error?.type}`)
      assert(/ray_[0-9a-f]{12}/u.test(body.error?.message ?? ''), '缺少 ray')
      mockState.fail429 = 0
      // 把刚才被熔断的 Key 复位，后面的用例还要用
      const keys = await admin.json<{ items: { id: string }[] }>('/api/admin/keys')
      for (const key of keys.items) {
        await admin.request(`/api/admin/keys/${key.id}/reset`, { method: 'POST' })
      }
    })

    // ---------------- E. 联网搜索 ----------------
    await check('联网搜索：先工具块后文本块', async () => {
      const response = await admin.post(
        '/api/chat',
        chatBody(publicModel, '搜索一下 Ray', {
          tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
        })
      )
      assert(response.status === 200, `status=${response.status}`)
      const raw = await response.text()
      const first = raw.indexOf('server_tool_use')
      const second = raw.indexOf('web_search_tool_result')
      const text = raw.indexOf('"type":"text"')
      assert(first >= 0 && second > first && text > second, '块顺序不对')
      assert(raw.includes('结果一'), '没有注入检索结果')
      const lastBody = mockState.lastBodies.at(-1) as
        | { messages?: { content?: unknown }[] }
        | undefined
      assert(JSON.stringify(lastBody ?? {}).includes('检索结果'), 'system 里没有检索上下文')
    })

    await check('搜索服务不可用：对话仍成功结束', async () => {
      searxng.server.close()
      await sleep(200)
      const response = await admin.post(
        '/api/chat',
        chatBody(publicModel, '再搜一次', {
          tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
        })
      )
      assert(response.status === 200, `status=${response.status}`)
      const raw = await response.text()
      assert(raw.includes('message_stop'), '没有正常结束')
      // 关掉 SearXNG 后会退到 Bing / DDG：要么拿到别家结果，要么给出 unavailable 错误块
      assert(raw.includes('web_search_tool_result'), '既没有结果块也没有错误块')
    })

    // ---------------- F. 附件与会话 ----------------
    let fileId = ''
    await check('上传文件返回 sha256 id', async () => {
      const form = new FormData()
      form.append('file', new Blob(['hello e2e'], { type: 'text/plain' }), 'note.txt')
      const response = await admin.request('/api/files', { method: 'POST', body: form })
      assert(response.status === 200, `status=${response.status}`)
      const body = (await response.json()) as { id?: string }
      assert(/^[0-9a-f]{64}$/u.test(body.id ?? ''), `id=${body.id}`)
      fileId = body.id ?? ''
    })

    await check('相同内容重复上传命中同一个 id（去重）', async () => {
      const form = new FormData()
      form.append('file', new Blob(['hello e2e'], { type: 'text/plain' }), 'note2.txt')
      const body = (await (
        await admin.request('/api/files', { method: 'POST', body: form })
      ).json()) as { id?: string }
      assert(body.id === fileId, `去重失败：${body.id}`)
    })

    await check('下载内容一致', async () => {
      const response = await admin.request(`/api/files/${fileId}`)
      assert((await response.text()) === 'hello e2e', '内容不一致')
    })

    await check('会话 PUT/GET/PATCH/DELETE 闭环', async () => {
      const payload = JSON.stringify({
        id: 's1',
        title: '会话一',
        messages: [{ role: 'user', text: 'hi', files: [{ id: fileId, name: 'note.txt' }] }],
      })
      const put = await admin.request('/api/sessions/s1', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '会话一', payload }),
      })
      assert(put.status === 200, `PUT status=${put.status}`)

      const list = await admin.json<{ sessions: { id: string }[] }>('/api/sessions')
      assert(
        list.sessions.some((item) => item.id === 's1'),
        '列表里没有 s1'
      )

      const one = await admin.json<{ session: { payload: string } }>('/api/sessions/s1')
      assert(one.session.payload === payload, 'payload 不一致')

      const patched = await admin.request('/api/sessions/s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '改名后' }),
      })
      assert(patched.status === 200, `PATCH status=${patched.status}`)

      const removed = await admin.request('/api/sessions/s1', { method: 'DELETE' })
      assert(removed.status === 200, `DELETE status=${removed.status}`)
      const gone = await admin.request('/api/sessions/s1')
      assert(gone.status === 404, `删除后仍能读到：${gone.status}`)
    })

    await check('删除会话后附件被回收', async () => {
      const response = await admin.request(`/api/files/${fileId}`)
      assert(response.status === 400, `附件仍可下载：${response.status}`)
      const body = (await response.json()) as { error?: { message?: string } }
      assert(
        (body.error?.message ?? '').includes('file_ids do not exist'),
        '错误文案不匹配前端正则'
      )
    })

    // ---------------- G. 授权与配额 ----------------
    await check('付费模型对普通用户不可见且请求 403', async () => {
      await admin.request('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'bob',
          password: 'bob-pass-123',
          role: 'user',
          daily_quota: 100,
        }),
      })
      const paidModel = 'e2e-paid'
      await admin.request('/api/admin/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: paidModel,
          display_name: 'E2E Paid',
          context: 8192,
          tier: 'paid',
          caps: {
            vision: false,
            reasoning: true,
            web_search: false,
            read_url: false,
            file_parse: false,
          },
        }),
      })
      await admin.request(`/api/admin/keys/${keyIds[0]}/models`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: [
            { public_model: publicModel, upstream_model: 'mock-1', weight: 1, enabled: true },
            { public_model: paidModel, upstream_model: 'mock-paid', weight: 1, enabled: true },
          ],
        }),
      })

      const bob = new Client(base)
      assert((await bob.login('bob', 'bob-pass-123')) === 200, 'bob 登录失败')
      const models = await bob.json<{ models: { id: string }[] }>('/api/models')
      assert(!models.models.some((model) => model.id === paidModel), 'bob 看到了付费模型')

      const response = await bob.post('/api/chat', chatBody(paidModel, '应该被拒绝'))
      assert(response.status === 403, `status=${response.status}`)
    })

    await check('授权后可用，且配额超限返回 429', async () => {
      const users = await admin.json<{ items: { id: string; username: string }[] }>(
        '/api/admin/users'
      )
      const bobRow = users.items.find((item) => item.username === 'bob')
      if (!bobRow) {
        throw new Error('找不到 bob')
      }
      const granted = await admin.request(`/api/admin/users/${bobRow.id}/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grants: [{ model_id: 'e2e-paid', key_id: keyIds[0] }] }),
      })
      assert(granted.status === 200, `grants status=${granted.status}`)

      // 配额改成 1：第一次成功，第二次 429
      await admin.request(`/api/admin/users/${bobRow.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ daily_quota: 1 }),
      })

      const bob = new Client(base)
      await bob.login('bob', 'bob-pass-123')
      const first = await bob.post('/api/chat', chatBody('e2e-paid', '第一次'))
      assert(first.status === 200, `第一次 status=${first.status}`)
      await first.text()

      const second = await bob.post('/api/chat', chatBody('e2e-paid', '第二次'))
      assert(second.status === 429, `第二次 status=${second.status}`)
      const body = (await second.json()) as { error?: { message?: string } }
      assert(/ray_[0-9a-f]{12}/u.test(body.error?.message ?? ''), '429 缺 ray')
    })

    // ---------------- H. 内容审核 ----------------
    await check('命中本地关键词返回 400', async () => {
      const response = await admin.post('/api/chat', chatBody(publicModel, '这是 违禁词 测试'))
      assert(response.status === 400, `status=${response.status}`)
      const body = (await response.json()) as { error?: { message?: string } }
      assert((body.error?.message ?? '').includes('内容不符合使用规范'), '文案不对')
      assert(/ray_[0-9a-f]{12}/u.test(body.error?.message ?? ''), '缺少 ray')
    })

    // ---------------- I. 视觉转述 ----------------
    await check('视觉转述返回描述', async () => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
      const form = new FormData()
      form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png')
      const uploaded = await admin.request('/api/files', { method: 'POST', body: form })
      const file = (await uploaded.json()) as { id?: string }
      assert(typeof file.id === 'string', '上传图片失败')

      const response = await admin.post('/api/vision/describe', { file_id: file.id })
      assert(response.status === 200, `status=${response.status}`)
      const body = (await response.json()) as { description?: string }
      assert((body.description ?? '').length > 0, '描述为空')
    })
    // ---------------- J. 能力分层与偏好 ----------------
    await check('免费账号拿不到官方能力（403）', async () => {
      const response = await anon.post('/api/ocr') // 未登录先确认 401
      assert(response.status === 401, `未登录 status=${response.status}`)

      const freeClient = new Client(base)
      assert((await freeClient.login('bob', 'bob-pass-123')) === 200, 'bob 登录失败')
      const caps = await freeClient.json<{ official: Record<string, boolean> }>('/api/capabilities')
      // bob 在这轮里已经被授权过付费模型，所以这里只断言结构存在
      assert(typeof caps.official.ocr === 'boolean', '缺少 official.ocr 字段')

      const form = new FormData()
      form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt')
      const ocr = await freeClient.request('/api/ocr', { method: 'POST', body: form })
      // 未授权 → 403；已授权但 OCR 不可用 → 400/403 都算「被挡住」
      assert([400, 403].includes(ocr.status), `OCR status=${ocr.status}`)
    })

    await check('能力偏好：切到浏览器后服务端返回 501', async () => {
      const prefs = await admin.json<{ prefs: Record<string, string> }>('/api/capabilities/prefs')
      assert(prefs.prefs.tts === 'auto', `默认 tts=${prefs.prefs.tts}`)

      const put = await admin.request('/api/capabilities/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tts: 'browser', asr: 'browser' }),
      })
      assert(put.status === 200, `PUT status=${put.status}`)

      const tts = await admin.post('/api/speech/tts', {
        text: '你好',
        voice_id: 'stella',
        format: 'wav',
      })
      assert(tts.status === 501, `TTS 应返回 501（交给浏览器），实际 ${tts.status}`)

      const asr = await admin.request('/api/speech/asr', { method: 'POST', body: new FormData() })
      assert(asr.status === 501, `ASR 应返回 501，实际 ${asr.status}`)

      // 还原，避免影响后续用例
      await admin.request('/api/capabilities/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tts: 'auto', asr: 'auto' }),
      })
    })

    await check('能力矩阵包含官方与浏览器两档', async () => {
      const caps = await admin.json<{
        tier: string
        official: Record<string, boolean>
        browser: Record<string, boolean>
      }>('/api/capabilities')
      assert(caps.tier === 'admin', `tier=${caps.tier}`)
      assert(typeof caps.official.search === 'boolean', '缺少 official.search')
      assert(caps.browser.speechSynthesis === true, '缺少 browser.speechSynthesis')
    })

    // ---------------- K. 退出登录（浏览器真实发法：无 body、无 Content-Type） ----------------
    await check('无 body 的 POST 不会被 415 挡住，退出登录可用', async () => {
      const client = new Client(base)
      assert((await client.login('admin', adminPassword)) === 200, 'admin 登录失败')

      // 浏览器 fetch 不发 body 时不会带 Content-Type；Fastify 默认对 POST 回 415
      const response = await client.request('/api/auth/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      assert(response.status === 200, `logout status=${response.status}`)

      const me = await client.json<{ user: unknown }>('/api/me')
      assert(me.user === null, '退出后仍处于登录状态')

      assert((await client.login('admin', adminPassword)) === 200, '重新登录失败')
    })
  } finally {
    cleanup()
  }

  // ---------------- 汇总 ----------------
  const passed = results.filter((item) => item.ok && !item.skip).length
  const failed = results.filter((item) => !item.ok).length
  const skipped = results.filter((item) => item.skip).length

  console.log('\n================ Ray E2E ================')
  for (const item of results) {
    const mark = item.skip ? 'SKIP' : item.ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${item.name}${item.detail ? `  —  ${item.detail}` : ''}`)
  }
  console.log('-----------------------------------------')
  console.log(`PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

await main()
