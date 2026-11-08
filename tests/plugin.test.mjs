/**
 * 测试 5：装配集成 —— 用**假宿主 ctx** 走一遍 apply()，验证分层与门禁。
 *
 * 覆盖：
 *   · 项目文件不存在 → 装配成功但 send 被门禁挡住（E_DISABLED），snapshot 是关闭态；
 *   · 项目文件 enabled=true → 能发消息、读信箱、列身份；
 *   · profile 侧 enabled=true 但项目文件不存在 → 仍然关闭（「仅项目内生效」的硬约束）；
 *   · fail-fast：Node/DSH 版本不满足时 assertHostCompatibility 抛错；
 *   · 卸载（ctx.effect 的 disposer）后工具与路由都被摘掉。
 *
 * 假 ctx 只实现插件真正用到的那几个面（inject / effect / get / logger），
 * 刻意不引入 cordis —— 让这条用例在任何机器上都能跑。
 *
 * 注意：全程只用**项目内**的 `.dsh-bus.json`；不涉及 openclaw.json。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { assertHostCompatibility, isNodeVersionSupported, parseVersion, compareVersions } from '../src/compat.ts'
import { DEFAULT_PROJECT_CONFIG_NAME } from '../src/config/project-config.ts'

/** 一个最小的假宿主。 */
function fakeHost(options = {}) {
  const services = new Map()
  const effects = []
  const tools = new Map()
  const routes = new Map()
  const commands = new Map()
  const logs = []

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    get: (name) => services.get(name),
    inject: (deps, callback) => {
      const resolved = {}
      for (const dep of deps) resolved[dep] = services.get(dep)
      try {
        callback(resolved)
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

  const host = {
    ctx,
    logs,
    effects,
    tools,
    routes,
    commands,
    provide(name, value) {
      services.set(name, value)
    },
    /** 模拟宿主卸载：跑所有 effect disposer。 */
    dispose() {
      for (const disposer of effects.splice(0)) disposer()
    },
  }

  if (options.withTools !== false) {
    host.provide('tools', {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    })
  }
  if (options.withWebServer !== false) {
    host.provide('webServer', {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    })
    host.provide('connection', { requestRejection: () => undefined })
  }
  if (options.withCommands !== false) {
    host.provide('commands', {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    })
  }
  return host
}

/** 在项目根下写 `.dsh-bus.json`（本插件唯一的业务开关）。 */
async function writeProjectConfig(projectRoot, block) {
  const file = join(projectRoot, DEFAULT_PROJECT_CONFIG_NAME)
  await writeFile(file, JSON.stringify(block, null, 2), 'utf8')
  return file
}

test('fail-fast：Node 版本判定与 semver 比较', () => {
  assert.equal(isNodeVersionSupported('22.5.0'), true)
  assert.equal(isNodeVersionSupported('22.4.0'), false)
  assert.equal(isNodeVersionSupported('24.0.0'), true)
  assert.equal(compareVersions(parseVersion('0.2.1'), parseVersion('0.2.1-rc.2')), 1)
  assert.equal(compareVersions(parseVersion('0.2.1-rc.3'), parseVersion('0.2.1-rc.2')), 1)
  assert.equal(compareVersions(parseVersion('0.2.0'), parseVersion('0.2.1-rc.2')), -1)
})

test('fail-fast：DSH 版本过低直接抛（不半坏着跑）', () => {
  assert.throws(() => assertHostCompatibility('0.1.0'), /需要 DSH >=/)
})

test('fail-fast：宿主版本未知只警告，不抛', () => {
  const warnings = []
  assertHostCompatibility(undefined, { warn: (message) => warnings.push(message) })
  assert.equal(warnings.length, 1)
})

test('未开启（项目文件不存在）：装配成功但 send 被门禁挡住，snapshot 是关闭态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-apply-'))
  let host
  try {
    host = fakeHost()
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    // 工具与路由都注册了（UI 需要它们来展示「未开启」与开启方法）
    assert.ok(host.tools.has('dsh_bus_send'))
    assert.ok(host.routes.has('/plugins/dsh-session-send/status'))

    const sendTool = host.tools.get('dsh_bus_send')
    await assert.rejects(
      () => sendTool.execute({ to: 'x', text: 'hi' }, { agent: { id: 's-1' } }),
      (error) => error.code === 'E_DISABLED',
    )

    const { internals } = await import('../src/index.ts')
    const service = internals().mounted.service
    const snapshot = await service.snapshot('s-1', 10)
    assert.equal(snapshot.enabled, false)
    assert.deepEqual(snapshot.messages, [])

    const status = service.status()
    assert.equal(status.projectRoot, dir)
    assert.equal(status.configPresent, false)
    assert.match(String(status.disabledReason), /不存在/)
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('仅项目内生效：profile enabled=true 但项目文件不存在 → 仍然关闭', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-scope-'))
  let host
  try {
    host = fakeHost()
    // profile patch 里 enabled=true（第一个锁打开），但项目没有 .dsh-bus.json
    await apply(host.ctx, { projectRoot: dir, enabled: true })
    const { internals } = await import('../src/index.ts')
    const service = internals().mounted.service
    assert.equal(service.config().enabled, false, '项目文件缺席时绝不能放开')
    await assert.rejects(() => service.send({ from: 'a', to: 'b', payload: 'x' }), (e) => e.code === 'E_DISABLED')
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('开启：能发消息、能读信箱、能列身份；卸载后工具与路由被摘掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-apply-'))
  let host
  try {
    await writeProjectConfig(dir, {
      enabled: true,
      transport: { kind: 'in-process' },
      registry: { sources: ['dsh-sessions'] },
    })
    host = fakeHost()
    // 让 dsh-sessions provider 有两个活着的会话
    host.provide('agents', {
      list: () => [
        { id: 's-1', session: { header: { title: 'alpha', cwd: dir } } },
        { id: 's-2', session: { header: { title: 'beta', cwd: dir } } },
      ],
      get: (id) => ({ id, session: { header: {} } }),
    })
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    const { internals } = await import('../src/index.ts')
    assert.ok(internals().mounted !== undefined)

    const agentsTool = host.tools.get('dsh_bus_agents')
    const agentList = await agentsTool.execute({}, { agent: { id: 's-1' } })
    assert.equal(agentList.agents.length, 2)

    const sendTool = host.tools.get('dsh_bus_send')
    const receipt = await sendTool.execute({ to: 'beta', text: 'ping' }, { agent: { id: 's-1' } })
    assert.equal(receipt.ok, true)
    assert.equal(receipt.messages[0].toId, 's-2')

    const inboxTool = host.tools.get('dsh_bus_inbox')
    const inbox = await inboxTool.execute({}, { agent: { id: 's-2' } })
    assert.equal(inbox.messages.length, 1)
    assert.equal(inbox.messages[0].payload.text, 'ping')
    assert.equal(inbox.unread[0].count, 1)

    // reply 走 replyTo 关联，不需要手填收件人
    const replyTool = host.tools.get('dsh_bus_reply')
    const reply = await replyTool.execute(
      { replyTo: inbox.messages[0].id, text: 'pong' },
      { agent: { id: 's-2' } },
    )
    assert.equal(reply.to, 's-1', '回复自动回到原消息发送方')

    host.dispose()
    assert.equal(host.tools.size, 0, '卸载后工具应全部摘掉')
    assert.equal(host.routes.size, 0, '卸载后路由应全部摘掉')
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('HTTP 面：status / agents / messages / send / read 五个路由都可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-http-'))
  let host
  try {
    await writeProjectConfig(dir, {
      enabled: true,
      transport: { kind: 'file', fileDir: join(dir, '.dsh-bus') },
      registry: { sources: ['dsh-sessions'] },
    })
    host = fakeHost()
    host.provide('agents', {
      list: () => [
        { id: 's-1', session: { header: { title: 'alpha', cwd: dir } } },
        { id: 's-2', session: { header: { title: 'beta', cwd: dir } } },
      ],
    })
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    const call = async (path, init) => {
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

    const status = await call('/plugins/dsh-session-send/status')
    assert.equal(status.status, 200)
    assert.equal(status.body.status.enabled, true)
    assert.equal(status.body.status.projectRoot, dir)

    const agents = await call('/plugins/dsh-session-send/agents?owner=s-1')
    assert.equal(agents.status, 200)
    assert.equal(agents.body.agents.length, 2)

    const sent = await call('/plugins/dsh-session-send/send', {
      method: 'POST',
      body: JSON.stringify({ from: 's-1', to: 'beta', kind: 'text', payload: { text: 'via http' } }),
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.receipt.messages.length, 1)

    const messages = await call('/plugins/dsh-session-send/messages?owner=s-2')
    assert.equal(messages.status, 200)
    assert.equal(messages.body.messages.length, 1)

    const read = await call('/plugins/dsh-session-send/read', {
      method: 'POST',
      body: JSON.stringify({ target: 's-2', ids: messages.body.messages.map((message) => message.id) }),
    })
    assert.equal(read.status, 200)
    assert.equal(read.body.changed, 1)
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('HTTP 面：目标不存在返回 404 与明确错误码', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-http-'))
  let host
  try {
    await writeProjectConfig(dir, {
      enabled: true,
      transport: { kind: 'in-process' },
      registry: { sources: ['dsh-sessions'] },
    })
    host = fakeHost()
    host.provide('agents', { list: () => [{ id: 's-1', session: { header: { title: 'alpha', cwd: dir } } }] })
    await apply(host.ctx, { projectRoot: dir, enabled: true })

    const handler = host.routes.get('/plugins/dsh-session-send/send')
    const body = JSON.stringify({ from: 's-1', to: 'ghost', payload: { text: 'x' } })
    const req = { method: 'POST', url: '/x', headers: {} }
    req.on = (event, callback) => {
      if (event === 'data') for (const chunk of [Buffer.from(body)]) callback(chunk)
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
      end: (raw) => {
        captured.body = JSON.parse(raw)
      },
    }
    await handler(req, res)
    assert.equal(captured.status, 404)
    assert.equal(captured.body.error.code, 'E_TARGET_NOT_FOUND')
  } finally {
    host?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})
