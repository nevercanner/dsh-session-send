/**
 * 测试 7：项目开关的**端到端**行为 —— 通过 HTTP 路由点开关，验证
 * 「点一下 → 写文件 → 热生效 → 能立刻发消息」整条链路，全程不重启宿主。
 *
 * 这是用户要求的核心：「不要手写文件，点一下就开」「关了也能从这个菜单关」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { DEFAULT_PROJECT_CONFIG_NAME } from '../src/config/project-config.ts'

function fakeHost() {
  const services = new Map()
  const effects = []
  const tools = new Map()
  const routes = new Map()
  const logs = []

  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    get: (name) => services.get(name),
    inject: (deps, cb) => {
      const resolved = {}
      for (const dep of deps) resolved[dep] = services.get(dep)
      try {
        cb(resolved)
      } catch (error) {
        logs.push(['warn', `inject(${deps.join(',')}) 失败：${String(error)}`])
      }
    },
    effect: (factory) => {
      const disposer = factory()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
  }

  services.set('tools', {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  })
  services.set('webServer', {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  })
  services.set('connection', { requestRejection: () => undefined })
  services.set('commands', {
    register(definition) {
      services.set(`cmd:${definition.name}`, definition)
      return () => services.delete(`cmd:${definition.name}`)
    },
  })

  return {
    ctx,
    logs,
    tools,
    routes,
    services,
    dispose() {
      for (const disposer of effects.splice(0)) disposer()
    },
  }
}

/** 用假 req/res 调一个已注册路由。 */
async function call(host, path, init) {
  const [pathname, query] = path.split('?')
  const handler = host.routes.get(pathname)
  assert.ok(handler, `缺路由 ${pathname}`)
  const req = {
    method: init?.method ?? 'GET',
    url: query === undefined ? pathname : `${pathname}?${query}`,
    headers: {},
  }
  const chunks = init?.body === undefined ? [] : [Buffer.from(init.body)]
  req.on = (event, callback) => {
    if (event === 'data') for (const chunk of chunks) callback(chunk)
    return req
  }
  req.once = (event, callback) => {
    if (event === 'end') setTimeout(callback, 0)
    return req
  }
  req.off = () => req
  req.resume = () => {}
  const captured = { status: 0, body: undefined }
  const res = {
    writeHead: (status) => {
      captured.status = status
    },
    end: (body) => {
      captured.body = body === undefined ? undefined : JSON.parse(body)
    },
  }
  await handler(req, res)
  return captured
}

const post = (host, path, payload) =>
  call(host, path, { method: 'POST', body: JSON.stringify(payload) })

test('点一下开启：写文件 + 热生效，随后立刻能发消息（不重启）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-switch-'))
  let host
  try {
    host = fakeHost()
    host.services.set('agents', {
      list: () => [
        { id: 's-1', session: { header: { title: 'alpha', cwd: dir } } },
        { id: 's-2', session: { header: { title: 'beta', cwd: dir } } },
      ],
      get: (id) => ({ id }),
    })
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    // ① 初始：关闭
    const before = await call(host, '/plugins/openclaw-dsh-bus/status')
    assert.equal(before.body.status.enabled, false)
    assert.equal(before.body.status.configPresent, false)
    assert.match(String(before.body.status.disabledReason), /不存在/)

    // ② 点开关（菜单那一行发的就是这个请求，省略 enabled = 翻转）
    const toggled = await post(host, '/plugins/openclaw-dsh-bus/project', { project: dir })
    assert.equal(toggled.status, 200)
    assert.equal(toggled.body.project.enabled, true)
    assert.equal(toggled.body.status.enabled, true, 'service 必须已经热切换')

    // ③ 文件真的写出来了，内容是最小可跑配置
    const raw = JSON.parse(await readFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), 'utf8'))
    assert.equal(raw.enabled, true)
    assert.equal(raw.transport.kind, 'sqlite')
    assert.equal(raw.scope, 'project')

    // ④ 不用重启：立刻能发消息
    const sent = await post(host, '/plugins/openclaw-dsh-bus/send', {
      from: 's-1',
      to: 'beta',
      payload: { text: 'just enabled' },
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.receipt.messages.length, 1)

    // ⑤ 工具侧也通了（同一份 runtime）
    const agentsTool = host.tools.get('dsh_bus_agents')
    const list = await agentsTool.execute({}, { agent: { id: 's-1' } })
    assert.equal(list.agents.length, 2)
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('再点一下关闭：写盘 + 热生效，消息接口立刻回到 E_DISABLED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-switch-'))
  let host
  try {
    host = fakeHost()
    host.services.set('agents', { list: () => [{ id: 's-1', session: { header: { title: 'alpha' } } }] })
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    await post(host, '/plugins/openclaw-dsh-bus/project', { project: dir })
    const off = await post(host, '/plugins/openclaw-dsh-bus/project', { project: dir })
    assert.equal(off.body.project.enabled, false)
    assert.equal(off.body.status.enabled, false)

    const raw = JSON.parse(await readFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), 'utf8'))
    assert.equal(raw.enabled, false, '关掉是把 enabled 置 false，不是删文件')

    const denied = await post(host, '/plugins/openclaw-dsh-bus/send', {
      from: 's-1',
      to: 's-1',
      payload: { text: 'x' },
    })
    assert.equal(denied.status, 409)
    assert.equal(denied.body.error.code, 'E_DISABLED')
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('显式 enabled=true/false 也可用（幂等，不靠翻转）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-switch-'))
  let host
  try {
    host = fakeHost()
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    const on = await post(host, '/plugins/openclaw-dsh-bus/project', { project: dir, enabled: true })
    assert.equal(on.body.project.enabled, true)
    const stillOn = await post(host, '/plugins/openclaw-dsh-bus/project', { project: dir, enabled: true })
    assert.equal(stillOn.body.project.enabled, true, '重复设 true 保持 true')

    const off = await post(host, '/plugins/openclaw-dsh-bus/project', { project: dir, enabled: false })
    assert.equal(off.body.project.enabled, false)
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /project：读状态，不创建配置文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-switch-'))
  let host
  try {
    host = fakeHost()
    await apply(host.ctx, { projectRoot: dir, enabled: true })
    // 注意：初次 mount 会建 transport（sqlite 会建 .dsh-bus/ 目录与库文件），
    // 那是装配行为，与本用例要守的「读状态不写配置文件」无关。
    const state = await call(host, `/plugins/openclaw-dsh-bus/project?project=${encodeURIComponent(dir)}`)
    assert.equal(state.status, 200)
    assert.equal(state.body.project.enabled, false)
    assert.equal(state.body.project.present, false)

    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    assert.deepEqual(
      files.filter((name) => name === DEFAULT_PROJECT_CONFIG_NAME),
      [],
      '读状态不该写出配置文件',
    )
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /project 读「另一个」项目：不在那边建任何东西（不装配）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  const other = await mkdtemp(join(tmpdir(), 'dshbus-other-'))
  let host
  try {
    host = fakeHost()
    await apply(host.ctx, { projectRoot: home, enabled: true })
    const state = await call(host, `/plugins/openclaw-dsh-bus/project?project=${encodeURIComponent(other)}`)
    assert.equal(state.status, 200)
    assert.equal(state.body.project.enabled, false)

    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(other), [], '探测另一个项目不该在它目录里留下任何东西（含 .dsh-bus/）')
  } finally {
    host?.dispose?.()
    await rm(home, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('项目根校验：不存在/非目录/空值都被拒（不让人乱改无关路径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-switch-'))
  let host
  try {
    host = fakeHost()
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    const missing = await post(host, '/plugins/openclaw-dsh-bus/project', {
      project: join(dir, 'does-not-exist'),
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'E_TARGET_NOT_FOUND')

    const empty = await post(host, '/plugins/openclaw-dsh-bus/project', {})
    assert.equal(empty.status, 404)
    assert.equal(empty.body.error.code, 'E_TARGET_NOT_FOUND')

    const file = join(dir, 'a-file.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'x', 'utf8')
    const notDir = await post(host, '/plugins/openclaw-dsh-bus/project', { project: file })
    assert.equal(notDir.status, 404)
    assert.match(String(notDir.body.error.message), /不是目录/)
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('切到「另一个」项目：为那个项目建配置，且不影响当前 runtime 所在项目', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  const other = await mkdtemp(join(tmpdir(), 'dshbus-other-'))
  let host
  try {
    host = fakeHost()
    await apply(host.ctx, { projectRoot: home, enabled: true })

    const state = await post(host, '/plugins/openclaw-dsh-bus/project', { project: other })
    assert.equal(state.body.project.projectRoot, other)
    assert.equal(state.body.project.enabled, true)

    const otherRaw = JSON.parse(await readFile(join(other, DEFAULT_PROJECT_CONFIG_NAME), 'utf8'))
    assert.equal(otherRaw.enabled, true)

    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(home, DEFAULT_PROJECT_CONFIG_NAME)), false, 'home 项目不该被连带写')
  } finally {
    host?.dispose?.()
    await rm(home, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})
