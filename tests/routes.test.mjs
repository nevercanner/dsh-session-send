/**
 * 测试 8：路由注册的**容错**。
 *
 * 真实事故：宿主对 exact 路由去重，同名路径再注册会抛 duplicate。
 * 热重载时上一代 entry 的路由没摘干净，于是第一条 `/status` 就抛 ——
 * 而当时的实现是「一抛就中断」，导致后面新加的 `/project` 永远挂不上，
 * 症状表现为「路由表缺一截」，极难排查。
 *
 * 这条用例守死行为：**一条注册失败不许影响后面的路由**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerBusRoutes } from '../src/api/routes.ts'

/** 假 webServer：按 exact 路径去重，重复注册抛错（与宿主一致）。 */
function makeWebServer(existing = []) {
  const table = new Map()
  for (const path of existing) table.set(path, async () => {})
  return {
    table,
    register(route) {
      if (table.has(route.path)) {
        throw new Error(`webserver: duplicate exact route "${route.path}"`)
      }
      table.set(route.path, route.handler)
      return () => table.delete(route.path)
    },
  }
}

const fakeBus = {
  status: () => ({ mounted: true, enabled: false }),
  snapshot: async () => ({ enabled: false, agents: [], unread: [{ target: '', count: 0 }], messages: [], sources: [] }),
  history: async () => [],
  send: async () => ({ ok: true, messages: [], deliveries: [] }),
  markRead: async () => 0,
}

const fakeControl = {
  status: async () => ({ projectRoot: '/x', enabled: false, present: false }),
  toggle: async () => ({ projectRoot: '/x', enabled: true, present: true }),
  set: async () => ({ projectRoot: '/x', enabled: true, present: true }),
}

function makeCtx(webServer, warnings) {
  return {
    get: (name) => (name === 'webServer' ? webServer : name === 'connection' ? { requestRejection: () => undefined } : undefined),
  }
}

const ALL_PATHS = [
  '/plugins/dsh-session-send/status',
  '/plugins/dsh-session-send/agents',
  '/plugins/dsh-session-send/messages',
  '/plugins/dsh-session-send/send',
  '/plugins/dsh-session-send/read',
  '/plugins/dsh-session-send/project',
]

test('干净环境：六条路由全部注册', () => {
  const ws = makeWebServer()
  const warnings = []
  const routes = registerBusRoutes({
    bus: fakeBus,
    control: fakeControl,
    ctx: makeCtx(ws, warnings),
    logger: { warn: (m) => warnings.push(m) },
  })
  assert.equal(routes.length, ALL_PATHS.length)
  assert.deepEqual([...ws.table.keys()].sort(), [...ALL_PATHS].sort())
})

test('上一代残留 5 条：只跳过它们，新的 /project 仍必须挂上', () => {
  const legacy = ALL_PATHS.slice(0, 5)
  const ws = makeWebServer(legacy)
  const warnings = []
  const routes = registerBusRoutes({
    bus: fakeBus,
    control: fakeControl,
    ctx: makeCtx(ws, warnings),
    logger: { warn: (m) => warnings.push(m) },
  })

  // 六条都「登记」了（失败的返回空 dispose，但不再中断）
  assert.equal(routes.length, ALL_PATHS.length, '注册循环不许中断')
  // /project 真的进了宿主表
  assert.ok(ws.table.has('/plugins/dsh-session-send/project'), '/project 必须被挂上')
  // 五条重复的都被记录成警告，便于排查
  assert.equal(warnings.filter((line) => line.includes('duplicate')).length, 5)
})

test('中途一条重复：后面的路由不被连带跳过', () => {
  // 只有 /send 残留（中间那条）
  const ws = makeWebServer(['/plugins/dsh-session-send/send'])
  const warnings = []
  registerBusRoutes({
    bus: fakeBus,
    control: fakeControl,
    ctx: makeCtx(ws, warnings),
    logger: { warn: (m) => warnings.push(m) },
  })
  assert.ok(ws.table.has('/plugins/dsh-session-send/status'), 'status 在 send 之前，应正常')
  assert.ok(ws.table.has('/plugins/dsh-session-send/read'), 'read 在 send 之后，也必须正常')
  assert.ok(ws.table.has('/plugins/dsh-session-send/project'), '最后一条也必须正常')
  assert.equal(warnings.length, 1)
})

test('webServer 缺席：返回空数组，不抛（headless profile）', () => {
  const routes = registerBusRoutes({
    bus: fakeBus,
    control: fakeControl,
    ctx: { get: () => undefined },
    logger: { warn: () => {} },
  })
  assert.deepEqual(routes, [])
})

test('失败的那条返回可调用的 dispose（调用不抛）', () => {
  const ws = makeWebServer(['/plugins/dsh-session-send/status'])
  const routes = registerBusRoutes({
    bus: fakeBus,
    control: fakeControl,
    ctx: makeCtx(ws, []),
    logger: { warn: () => {} },
  })
  const failed = routes.find((entry) => entry.path === '/plugins/dsh-session-send/status')
  assert.ok(failed !== undefined)
  assert.equal(typeof failed.dispose, 'function')
  assert.doesNotThrow(() => failed.dispose())
})
