/**
 * 测试 15：收件箱语义 + 会话显示名（来自管线维护会话的真实反馈）。
 *
 * 两个真问题：
 *   ① 自己发的消息出现在自己的信箱里 → 使用者误以为消息回环了
 *      根因：inbox 用 `involving`（from 或 to 任一侧是我）
 *      修法：默认只读 `to = 我`；看待发件箱要显式 direction="outbox"
 *
 *   ② 121 个会话全显示 `session-` / `c883810e`，无法判断哪条是哪条工作线
 *      根因：宿主的 title 是异步生成的，历史会话大多为空
 *      修法：支持项目配置的 labels 映射；没有时用「创建时间 + id 尾段」保证可区分
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionsProvider } from '../src/registry/dsh-sessions.ts'
import { CompositeRegistry } from '../src/registry/registry.ts'
import { createRouter } from '../src/router/index.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { DEFAULT_CONFIG } from '../src/config/schema.ts'

const LOOP = 'D:\\openclaw-data\\agents\\shared\\SOP\\loop'

function rec(id, options = {}) {
  return {
    header: {
      id,
      cwd: options.cwd ?? LOOP,
      title: options.title,
      createdAt: options.createdAt ?? 1794124151026,
    },
    live: options.live ?? false,
    persisted: true,
  }
}

function host({ persisted = [], live = {} } = {}) {
  return {
    get(name) {
      if (name === 'agents') return { list: () => Object.values(live), get: (id) => live[id] }
      if (name === 'sessionQuery') return { listSessions: async () => persisted }
      return undefined
    },
  }
}

// ─────────────────────────────────────────────────────────────
// ① 收件箱语义
// ─────────────────────────────────────────────────────────────

test('inbox：只列出「发给我的」，自己发出去的不算', async () => {
  const ctx = host({ persisted: [rec('me'), rec('other')] })
  const registry = new CompositeRegistry([new DshSessionsProvider({ ctx, projectRoot: LOOP , requireRegistration: false })])
  const transport = new InProcessTransport()
  const router = createRouter({ config: { ...DEFAULT_CONFIG, enabled: true }, transport, registry })

  // 我发出去一条
  await router.send({ from: 'me', to: 'other', payload: 'outgoing' })
  // 别人发给我一条
  await router.send({ from: 'other', to: 'me', payload: 'incoming' })

  // 旧的 `involving` 语义：两条都会出现（错误行为）
  const involving = await transport.list({ involving: 'me' })
  assert.equal(involving.length, 2, 'involving 确实是双向的 —— 这就是误报来源')

  // 新的 inbox 语义：只看到发给我的那条
  const inbox = await transport.list({ to: 'me' })
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].payload.text, 'incoming')

  // outbox：只看到我发出去的那条
  const outbox = await transport.list({ from: 'me' })
  assert.equal(outbox.length, 1)
  assert.equal(outbox[0].payload.text, 'outgoing')
})

test('inbox：未读数与收件箱条数一致（自己发的不计入未读）', async () => {
  const ctx = host({ persisted: [rec('me'), rec('other')] })
  const registry = new CompositeRegistry([new DshSessionsProvider({ ctx, projectRoot: LOOP , requireRegistration: false })])
  const transport = new InProcessTransport()
  const router = createRouter({ config: { ...DEFAULT_CONFIG, enabled: true }, transport, registry })

  await router.send({ from: 'me', to: 'other', payload: 'a' })
  await router.send({ from: 'me', to: 'other', payload: 'b' })
  await router.send({ from: 'other', to: 'me', payload: 'c' })

  const inbox = await transport.list({ to: 'me' })
  const unread = (await transport.unread(['me']))[0].count
  assert.equal(inbox.length, 1)
  assert.equal(unread, 1, '只有别人发的那条算未读')
})

// ─────────────────────────────────────────────────────────────
// ② 会话显示名
// ─────────────────────────────────────────────────────────────

test('显示名：宿主 title 优先', async () => {
  const ctx = host({ persisted: [rec('s-1', { title: '跑章选手' })] })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP , requireRegistration: false })
  const [entry] = await provider.list()
  assert.equal(entry.name, '跑章选手')
})

test('显示名：项目配置的 labels 覆盖宿主 title', async () => {
  const ctx = host({ persisted: [rec('s-1', { title: '自动生成的标题' })] })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: LOOP,
    labels: { 's-1': '门禁' },
  })
  const [entry] = await provider.list()
  assert.equal(entry.name, '门禁', '使用者配置的名字最权威')
})

test('显示名：都没有时用「时间 + id 尾段」，保证可区分', async () => {
  // 这是真实场景：121 个会话 title 全空
  const ctx = host({
    persisted: [
      rec('session-4c72b65e-da51-4a5f-999d-e9551e9f8dca', { createdAt: 1794124151026 }),
      rec('session-7a5a2cca-233a-4f40-8076-e84405f0970c', { createdAt: 1794119957050 }),
      rec('c883810e-da37-4ca6-a53c-007b9aa16eae', { createdAt: 1794106364882 }),
    ],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP , requireRegistration: false })
  const entries = await provider.list()

  // 关键：三个名字必须互不相同（旧实现全是 "session-"）
  const names = entries.map((e) => e.name)
  assert.equal(new Set(names).size, 3, `三个会话的名字必须可区分，实际：${JSON.stringify(names)}`)
  for (const name of names) {
    assert.notEqual(name, 'session-', '不能是毫无信息的 "session-"')
    assert.ok(name.length > 0)
  }
})

test('显示名：无 createdAt 时退化为 id 尾段', async () => {
  const ctx = host({
    persisted: [{ header: { id: 'session-abc123def456', cwd: LOOP }, live: false }],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP , requireRegistration: false })
  const [entry] = await provider.list()
  assert.match(entry.name, /abc123def456|def456|3456/, `应该含 id 尾段，实际：${entry.name}`)
})

test('显示名：labels 里为空字符串时不算命中', async () => {
  const ctx = host({ persisted: [rec('s-1', { title: '真标题' })] })
  // requireRegistration: false —— 这个用例只关心显示名解析，不关心参与门槛
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: LOOP,
    labels: { 's-1': '   ' },
    requireRegistration: false,
  })
  const [entry] = await provider.list()
  assert.equal(entry.name, '真标题', '空白 label 应被忽略')
})

test('显示名：活 Agent 也走同一套 label 逻辑', async () => {
  const liveAgent = {
    id: 's-live',
    session: { header: { id: 's-live', cwd: LOOP, createdAt: 1794124151026 } },
  }
  const ctx = host({ persisted: [], live: { 's-live': liveAgent } })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP, labels: { 's-live': '管线维护' } })
  const [entry] = await provider.list()
  assert.equal(entry.name, '管线维护')
})

// ─────────────────────────────────────────────────────────────
// 配置层
// ─────────────────────────────────────────────────────────────

test('配置：labels 接受字符串映射，忽略非法值', async () => {
  const { validateFallback } = await import('../src/config/schema.ts')
  const { value, warnings } = validateFallback({
    enabled: true,
    labels: { 's-1': '门禁', 's-2': 123, 's-3': '   ' },
  })
  assert.deepEqual(value.labels, { 's-1': '门禁' }, '只保留非空字符串')
  assert.equal(warnings.length, 2, '两个非法值各留一条警告')
})

test('配置：labels 缺席时默认空对象', async () => {
  const { validateFallback } = await import('../src/config/schema.ts')
  assert.deepEqual(validateFallback({}).value.labels, {})
})

test('labels 参与 to 解析：可以直接按名字发', async () => {
  const ctx = host({
    persisted: [
      rec('session-aaa', { createdAt: 1794124151026 }),
      rec('session-bbb', { createdAt: 1794119957050 }),
    ],
  })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: LOOP,
    labels: { 'session-bbb': '门禁' },
  })

  // 按 label 解析到正确 id
  const hits = await provider.resolve('门禁')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-bbb')
})

test('labels 参与 to 解析：活 Agent 也能按 label 命中', async () => {
  const liveAgent = {
    id: 'session-live',
    session: { header: { id: 'session-live', cwd: LOOP, createdAt: 1794124151026 } },
  }
  const ctx = host({ persisted: [], live: { 'session-live': liveAgent } })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: LOOP,
    labels: { 'session-live': '管线维护' },
  })
  const hits = await provider.resolve('管线维护')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-live')
})
