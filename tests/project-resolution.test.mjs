/**
 * 测试 10：**项目根按调用者解析**（真实事故的回归）。
 *
 * 事故：插件在宿主启动瞬间装配，那时 `currentInitiator()` 为空，
 * 于是回退到 `process.cwd()`（= profile 目录），把项目根定死在那里。
 * 之后所有调用都去读 `C:\Users\...\.dsh\profiles\desktop\.dsh-bus.json`，
 * 而我真正的工作目录 `D:\openclaw-data` 里明明有配置文件却报「未启用」。
 *
 * 守死的行为：项目根必须**每次调用**按调用者解析，不能在一次装配里定死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BusService, samePath } from '../src/api/service.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { CompositeRegistry } from '../src/registry/registry.ts'
import { createRouter } from '../src/router/index.ts'
import { DEFAULT_CONFIG } from '../src/config/schema.ts'

/** 造一个 runtime，projectRoot 可指定。 */
function makeRuntime(projectRoot, enabled = true) {
  const config = { ...DEFAULT_CONFIG, enabled }
  const transport = new InProcessTransport()
  const registry = new CompositeRegistry([
    {
      source: 'dsh-sessions',
      async available() {
        return true
      },
      async list() {
        return [{ id: 's-1', name: 'alpha', kind: 'session', source: 'dsh-sessions' }]
      },
      async resolve() {
        return [{ id: 's-1', name: 'alpha', kind: 'session', source: 'dsh-sessions' }]
      },
    },
  ])
  const router = createRouter({ config, transport, registry })
  return {
    config,
    projectRoot,
    projectConfigPath: `${projectRoot}/.dsh-bus.json`,
    transport,
    registry,
    router,
    warnings: [],
    configPresent: true,
    configDegraded: false,
  }
}

test('samePath：Windows 路径大小写与分隔符不敏感', () => {
  assert.equal(samePath('D:\\openclaw-data', 'd:/openclaw-data'), true)
  assert.equal(samePath('D:\\openclaw-data\\', 'D:\\openclaw-data'), true)
  assert.equal(samePath('D:\\openclaw-data', 'D:\\other'), false)
})

test('调用者属于另一个项目：自动重装配，用调用者自己的项目根', async () => {
  const built = []
  const service = new BusService({
    factory: async (root) => {
      built.push(root)
      return makeRuntime(root)
    },
    resolveProject: (exec) => exec?.agent?.session?.header?.cwd,
    initial: makeRuntime('C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop'),
  })

  // 初始 runtime 是 profile 目录（这就是事故现场）
  assert.equal(service.status()['projectRoot'], 'C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop')

  // 从 D:\openclaw-data 的会话调用 —— 必须切过去
  const receipt = await service.send(
    { from: 's-1', to: 'alpha', payload: 'hi' },
    { agent: { id: 's-1', session: { header: { cwd: 'D:\\openclaw-data' } } } },
  )
  assert.equal(receipt.ok, true)
  assert.deepEqual(built, ['D:\\openclaw-data'], '应该为调用者的项目重装配一次')
  assert.equal(service.status()['projectRoot'], 'D:\\openclaw-data')
})

test('同一个项目连续调用：只装配一次（不反复重建）', async () => {
  const built = []
  const service = new BusService({
    factory: async (root) => {
      built.push(root)
      return makeRuntime(root)
    },
    resolveProject: (exec) => exec?.agent?.session?.header?.cwd,
    initial: makeRuntime('D:\\openclaw-data'),
  })

  const exec = { agent: { id: 's-1', session: { header: { cwd: 'D:\\openclaw-data' } } } }
  await service.send({ from: 's-1', to: 'alpha', payload: 'a' }, exec)
  await service.send({ from: 's-1', to: 'alpha', payload: 'b' }, exec)
  await service.history({}, exec)
  assert.equal(built.length, 0, '初始 runtime 已经是这个项目，不该重建')
})

test('两个项目的会话来回调用：各自用自己的项目根', async () => {
  const built = []
  const service = new BusService({
    factory: async (root) => {
      built.push(root)
      return makeRuntime(root)
    },
    resolveProject: (exec) => exec?.agent?.session?.header?.cwd,
    initial: makeRuntime('D:\\openclaw-data'),
  })

  const fromA = { agent: { id: 's-1', session: { header: { cwd: 'D:\\openclaw-data' } } } }
  const fromB = { agent: { id: 's-2', session: { header: { cwd: 'D:\\deepseek' } } } }

  await service.send({ from: 's-1', to: 'alpha', payload: 'from A' }, fromA)
  assert.equal(service.status()['projectRoot'], 'D:\\openclaw-data')

  await service.send({ from: 's-2', to: 'alpha', payload: 'from B' }, fromB)
  assert.equal(service.status()['projectRoot'], 'D:\\deepseek')

  await service.send({ from: 's-1', to: 'alpha', payload: 'back to A' }, fromA)
  assert.equal(service.status()['projectRoot'], 'D:\\openclaw-data')

  assert.deepEqual(built, ['D:\\deepseek', 'D:\\openclaw-data'], '每次跨项目都重装配')
})

test('拿不到调用者信息：用当前 runtime，不乱切', async () => {
  const built = []
  const service = new BusService({
    factory: async (root) => {
      built.push(root)
      return makeRuntime(root)
    },
    resolveProject: () => undefined,
    initial: makeRuntime('D:\\openclaw-data'),
  })

  await service.send({ from: 's-1', to: 'alpha', payload: 'x' })
  assert.equal(built.length, 0)
  assert.equal(service.status()['projectRoot'], 'D:\\openclaw-data')
})

test('调用者项目未启用：报 E_DISABLED，且错误里点明是哪个项目的配置文件', async () => {
  const service = new BusService({
    factory: async (root) => makeRuntime(root, false),
    resolveProject: (exec) => exec?.agent?.session?.header?.cwd,
    initial: makeRuntime('D:\\openclaw-data'),
  })

  await assert.rejects(
    () =>
      service.send(
        { from: 's-1', to: 'alpha', payload: 'x' },
        { agent: { id: 's-1', session: { header: { cwd: 'D:\\no-config-project' } } } },
      ),
    (error) =>
      error.code === 'E_DISABLED' &&
      error.detail?.projectRoot === 'D:\\no-config-project',
  )
})

test('并发跨项目调用：串行化，不会互相踩', async () => {
  let active = 0
  let maxActive = 0
  const service = new BusService({
    factory: async (root) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return makeRuntime(root)
    },
    resolveProject: (exec) => exec?.agent?.session?.header?.cwd,
    initial: makeRuntime('D:\\openclaw-data'),
  })

  await Promise.all([
    service.send({ from: 's-1', to: 'alpha', payload: 'a' }, { agent: { session: { header: { cwd: 'D:\\p1' } } } }),
    service.send({ from: 's-2', to: 'alpha', payload: 'b' }, { agent: { session: { header: { cwd: 'D:\\p2' } } } }),
  ])
  assert.equal(maxActive, 1, '重装配必须串行，不能两份 runtime 同时建')
})
