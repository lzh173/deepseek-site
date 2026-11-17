/**
 * 冒烟脚本：登录 → 拉模型 → 发一条对话（SSE）→ 上传/读取一个文件。
 * 用法：
 *   RAY_ADMIN_PASSWORD=xxx node --experimental-strip-types scripts/smoke.ts
 * 或：pnpm smoke
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3000'
const USERNAME = process.env.RAY_ADMIN_USER ?? 'admin'
const PASSWORD = process.env.RAY_ADMIN_PASSWORD ?? 'ray-admin-123'

let cookie = ''
let failures = 0

const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0] ?? ''
  return res
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

const main = async (): Promise<void> => {
  console.log(`Ray 冒烟测试 @ ${BASE}`)

  const health = await call('/api/health')
  check('GET /api/health', health.ok, String(health.status))
  check('响应头带 x-ray-id', Boolean(health.headers.get('x-ray-id')))

  const unauth = await call('/api/models')
  const unauthBody = await json<{ error?: { message?: string } }>(unauth)
  check('未登录访问 /api/models 返回 401', unauth.status === 401, String(unauth.status))
  check('401 的 message 里带 ray', /ray_[0-9a-f]{12}/.test(unauthBody.error?.message ?? ''))

  const login = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  check(
    'POST /api/auth/login',
    login.ok,
    `status=${login.status} body=${await login.clone().text()}`
  )

  const me = await json<{ user: { username: string } | null }>(await call('/api/me'))
  check('GET /api/me 返回登录用户', me.user?.username === USERNAME)

  const modelsRes = await call('/api/models')
  const models = await json<{ models: { id: string; available: boolean }[] }>(modelsRes)
  check('GET /api/models', modelsRes.ok)
  console.log(
    `    可用模型：${models.models.map((m) => `${m.id}${m.available ? '' : '(无可用Key)'}`).join(', ') || '（空）'}`
  )

  const target = models.models.find((m) => m.available)
  if (!target) {
    console.log('  ! 没有可用模型，跳过对话与文件测试（先到管理端配渠道与 Key）')
  } else {
    const chatRes = await call('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: target.id,
        system: '',
        messages: [{ role: 'user', content: '用一句话打个招呼' }],
        thinking: { type: 'disabled' },
        tools: [],
        safety_check: { level: 'high' },
        title: { enabled: true },
        stream: true,
      }),
    })
    check(
      'POST /api/chat 200 + SSE',
      chatRes.status === 200 &&
        String(chatRes.headers.get('content-type')).includes('text/event-stream'),
      String(chatRes.status)
    )
    const text = await chatRes.text()
    check('收到 message_stop', text.includes('message_stop'))
    const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    console.log(`    事件序列：${types.join(' → ').slice(0, 200)}`)
  }

  const form = new FormData()
  form.append('file', new Blob(['hello ray'], { type: 'text/plain' }), 'hello.txt')
  const up = await call('/api/files', { method: 'POST', body: form })
  check('POST /api/files', up.ok, String(up.status))
  if (up.ok) {
    const obj = await json<{ id: string }>(up)
    const got = await call(`/api/files/${obj.id}`)
    check('GET /api/files/:id', got.ok && (await got.text()) === 'hello ray')
    const del = await call(`/api/files/${obj.id}`, { method: 'DELETE' })
    check('DELETE /api/files/:id', del.status === 204 || del.ok, String(del.status))
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('冒烟脚本异常：', error)
  process.exit(1)
})
