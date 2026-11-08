/**
 * 测试 9：**跨会话投递** —— 本插件的核心目标。
 *
 * 场景就是用户描述的那个：loop 项目下 7 个彼此**完全独立、平级**的会话
 * （管线维护、跑章选手、门禁…），其中一个发现问题时要把活直接交给另一个，
 * 不需要人复制粘贴。
 *
 * 这里用「假 Agent」验证投递器真正调到了 agent 的哪个方法：
 *   steer(input)    → 注入下一步 + 唤醒（运行中的目标在 step 边界看到）
 *   followup(input) → 作为下一轮 + 唤醒
 *   inject(input)   → 只注入不唤醒
 * 并且验证：目标不在本进程时降级为 durable（消息不丢），以及 push 失败不抛。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionPusher } from '../src/transport/session-push.ts'
import { createRouter } from '../src/router/index.ts'
import { CompositeRegistry } from '../src/registry/registry.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { DEFAULT_CONFIG } from '../src/config/schema.ts'

/** 一个假 Agent：记录收到的消息放在哪个口。 */
function fakeAgent(id, options = {}) {
  const calls = []
  const agent = {
    id,
    calls,
    steer(input) {
      calls.push({ via: 'steer', input })
      if (options.throwOnSteer) throw new Error('steer boom')
    },
    followup(input) {
      calls.push({ via: 'followup', input })
    },
    inject(input) {
      calls.push({ via: 'inject', input })
    },
    send(input, target) {
      calls.push({ via: `send:${target}`, input })
    },
  }
  return agent
}

/** 假宿主：只有 agents.get 会被用到。 */
function hostWith(agentsById) {
  return {
    get(name) {
      if (name !== 'agents') return undefined
      return { get: (id) => agentsById[id] }
    },
  }
}

test('steer（默认）：调入目标 agent 的 steer，消息内容完整到达', async () => {
  const target = fakeAgent('s-runner')
  const pusher = new SessionPusher({ ctx: hostWith({ 's-runner': target }) })
  const result = await pusher.push('s-runner', '跑第三章', 'steer')

  assert.equal(result.live, true)
  assert.equal(result.outcome, 'steered')
  assert.equal(target.calls.length, 1)
  assert.equal(target.calls[0].via, 'steer')
  const text = target.calls[0].input.content.find((block) => block.type === 'text').text
  assert.equal(text, '跑第三章')
})

test('followup：调入 followup（作为下一轮），不是 steer', async () => {
  const target = fakeAgent('s-gate')
  const pusher = new SessionPusher({ ctx: hostWith({ 's-gate': target }) })
  const result = await pusher.push('s-gate', '门禁请复核', 'followup')

  assert.equal(result.outcome, 'queued')
  assert.equal(target.calls[0].via, 'followup')
})

test('notify：只 inject，不唤醒', async () => {
  const target = fakeAgent('s-pipeline')
  const pusher = new SessionPusher({ ctx: hostWith({ 's-pipeline': target }) })
  const result = await pusher.push('s-pipeline', 'FYI', 'notify')

  assert.equal(result.outcome, 'notified')
  assert.equal(target.calls[0].via, 'inject')
})

test('目标不在本进程且无法冷启动：降级 durable，不抛，消息仍可后续取走', async () => {
  // hostWith({}) 没有 agentLoop，所以冷启动不可用 → 必须降级而不是抛错
  const pusher = new SessionPusher({ ctx: hostWith({}) })
  const result = await pusher.push('s-closed', '这条会在它下次打开时看到', 'steer')
  assert.equal(result.live, false)
  assert.equal(result.outcome, 'absent')
  assert.match(String(result.detail), /未激活|下次打开|冷启动|agentLoop/)
})

test('push 内部抛错：不向外扩散（消息已落库，只如实报告）', async () => {
  const target = fakeAgent('s-boom', { throwOnSteer: true })
  const warnings = []
  const pusher = new SessionPusher({ ctx: hostWith({ 's-boom': target }), logger: { warn: (m) => warnings.push(m) } })
  const result = await pusher.push('s-boom', 'x', 'steer')
  assert.equal(result.outcome, 'notified')
  assert.match(String(result.detail), /唤醒失败/)
  assert.equal(warnings.length, 1)
})

test('参数校验：空 session id / 空正文 明确报错', async () => {
  const pusher = new SessionPusher({ ctx: hostWith({}) })
  await assert.rejects(() => pusher.push('', 'x'), (e) => e.code === 'E_TARGET_NOT_FOUND')
  await assert.rejects(() => pusher.push('s-1', '   '), (e) => e.code === 'E_PAYLOAD_EMPTY')
})

test('isLive：只查不投递', () => {
  const target = fakeAgent('s-1')
  const pusher = new SessionPusher({ ctx: hostWith({ 's-1': target }) })
  assert.equal(pusher.isLive('s-1'), true)
  assert.equal(pusher.isLive('s-2'), false)
  assert.equal(target.calls.length, 0, '查询不该产生投递')
})

// ─────────────────────────────────────────────────────────────
// 端到端：7 个独立会话互相流转
// ─────────────────────────────────────────────────────────────

test('端到端：7 个平级会话，A 发给 D，D 真的被唤醒（不受父子关系限制）', async () => {
  const ids = ['pipeline', 'runner', 'gate', 'writer', 'checker', 'arbiter', 'editor']
  const agents = Object.fromEntries(ids.map((id) => [id, fakeAgent(id)]))
  const pusher = new SessionPusher({ ctx: hostWith(agents) })

  // 这些会话彼此没有父子关系 —— 完全平级。steer 不看关系，直接进对方收件箱。
  const registry = new CompositeRegistry([
    {
      source: 'dsh-sessions',
      async available() {
        return true
      },
      async list() {
        return ids.map((id) => ({ id, name: id, kind: 'session', source: 'dsh-sessions', status: 'live' }))
      },
      async resolve(ref) {
        return ids.includes(ref) ? [{ id: ref, name: ref, kind: 'session', source: 'dsh-sessions', status: 'live' }] : []
      },
    },
  ])

  const transport = new InProcessTransport()
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport,
    registry,
    sessions: pusher,
  })

  // 管线维护 → 跑章选手：交接工作
  const receipt = await router.send({ from: 'pipeline', to: 'runner', payload: '第三章管线已就绪，请跑章' })
  assert.equal(receipt.deliveries[0].mode, 'steered')
  assert.equal(agents.runner.calls.length, 1, '跑章选手必须真的收到')
  assert.match(
    agents.runner.calls[0].input.content[0].text,
    /第三章管线已就绪/,
  )

  // 跑章选手 → 门禁：接着交接
  await router.send({ from: 'runner', to: 'gate', payload: '第三章已完成，请复核' })
  assert.equal(agents.gate.calls.length, 1, '门禁必须真的收到')

  // 其余会话不受影响
  assert.equal(agents.writer.calls.length, 0)
  assert.equal(agents.editor.calls.length, 0)
})

test('端到端：broadcast 给 6 个同伴，每个都收到且互不干扰', async () => {
  const ids = ['pipeline', 'runner', 'gate', 'writer', 'checker', 'arbiter', 'editor']
  const agents = Object.fromEntries(ids.map((id) => [id, fakeAgent(id)]))
  const pusher = new SessionPusher({ ctx: hostWith(agents) })
  const registry = new CompositeRegistry([
    {
      source: 'dsh-sessions',
      async available() {
        return true
      },
      async list() {
        return ids.map((id) => ({ id, name: id, kind: 'session', source: 'dsh-sessions', status: 'live' }))
      },
      async resolve() {
        return []
      },
    },
  ])
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport: new InProcessTransport(),
    registry,
    sessions: pusher,
  })

  const receipt = await router.send({ from: 'pipeline', to: '*', payload: '全局通知' })
  assert.equal(receipt.messages.length, 6, '除自己外的 6 个')
  assert.equal(agents.pipeline.calls.length, 0, '发送方不给自己发')
  for (const id of ids.filter((x) => x !== 'pipeline')) {
    assert.equal(agents[id].calls.length, 1, `${id} 应收到 1 条`)
  }
})

test('端到端：deliveryMode 从 meta 透传到实际调用', async () => {
  const target = fakeAgent('s-gate')
  const registry = new CompositeRegistry([
    {
      source: 'dsh-sessions',
      async available() {
        return true
      },
      async list() {
        return [{ id: 's-gate', name: 'gate', kind: 'session', source: 'dsh-sessions' }]
      },
      async resolve() {
        return [{ id: 's-gate', name: 'gate', kind: 'session', source: 'dsh-sessions' }]
      },
    },
  ])
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport: new InProcessTransport(),
    registry,
    sessions: new SessionPusher({ ctx: hostWith({ 's-gate': target }) }),
  })

  await router.send({ from: 'pipeline', to: 'gate', payload: 'a', meta: { deliveryMode: 'followup' } })
  assert.equal(target.calls[0].via, 'followup')
})

test('端到端：目标离线 → durable，且消息确实落库（可被 inbox 取走）', async () => {
  const registry = new CompositeRegistry([
    {
      source: 'dsh-sessions',
      async available() {
        return true
      },
      async list() {
        return [{ id: 's-offline', name: 'offline', kind: 'session', source: 'dsh-sessions' }]
      },
      async resolve() {
        return [{ id: 's-offline', name: 'offline', kind: 'session', source: 'dsh-sessions' }]
      },
    },
  ])
  const transport = new InProcessTransport()
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport,
    registry,
    sessions: new SessionPusher({ ctx: hostWith({}) }),
  })

  const receipt = await router.send({ from: 'pipeline', to: 'offline', payload: '等你上线' })
  assert.equal(receipt.deliveries[0].mode, 'durable')
  assert.match(String(receipt.deliveries[0].detail), /未激活|下次打开|冷启动|agentLoop/)

  const inbox = await transport.list({ to: 's-offline' })
  assert.equal(inbox.length, 1, '离线也必须落库')
  assert.equal(inbox[0].payload.text, '等你上线')
  assert.equal((await transport.unread(['s-offline']))[0].count, 1)
})
