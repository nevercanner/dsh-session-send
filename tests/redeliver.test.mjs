/**
 * 测试：重发器（redeliver）—— 接收方模型没配好时，等它被重新激活自动补发未处理消息。
 *
 * 覆盖：
 *   · 默认关闭：enabled=false 时 agent/created 不触发任何重发
 *   · 激活重发：会话名下存在未读 bus 消息时，onAgentCreated 重新 push
 *   · 已被读的消息不重发（已处理 = 不再打扰）
 *   · 同一轮激活内同一条不重复推
 *   · 超过 maxAttempts 后放弃，不再推
 *   · 重发模式从消息 meta.deliveryMode 解析（默认 steer）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Redeliverer } from '../src/router/redeliver.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'

/** 记录调用的假投递器：只实现 redeliverer 用到的 push。 */
function fakeSessions() {
  const calls = []
  return {
    calls,
    /** 记录 push 并返回 outcome=steered（表示这回真推进去了）。 */
    async push(sessionId, text, mode, _opts) {
      calls.push({ sessionId, text, mode })
      return { live: true, outcome: 'steered', detail: undefined }
    },
  }
}

function makeRedeliverer({ enabled = true, maxAttempts = 3, transport, sessions, metaDeliveryMode } = {}) {
  return new Redeliverer({
    enabled,
    maxAttempts,
    transport,
    sessions,
    deliveryMode: (message) => {
      const raw = message?.meta?.['deliveryMode']
      if (metaDeliveryMode) return metaDeliveryMode
      return raw === 'followup' || raw === 'notify' || raw === 'steer' ? raw : 'steer'
    },
    logger: { info() {}, warn() {} },
  })
}

/** 往 transport 塞一条发给 target 的消息，返回 id。 */
async function seedMessage(transport, from, to, text, meta) {
  const written = await transport.appendMany([
    {
      id: `m-${to}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      kind: 'text',
      fromId: from,
      fromName: from,
      fromSource: 'unknown',
      toId: to,
      toName: to,
      payload: { text },
      meta,
    },
  ])
  return written[0]
}

test('默认关闭：enabled=false 时 onAgentCreated 不触发任何重发（不查 transport）', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  await seedMessage(transport, 's-1', 's-target', '欠着的一条')
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: false, transport, sessions })

  // enabled false：直接短路，连 unread 都不查
  await redeliverer.onAgentCreated('s-target')
  assert.equal(sessions.calls.length, 0, '关闭时不该有任何 push')
})

test('激活重发：会话名下有未读 bus 消息时，onAgentCreated 重新 push 它', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  await seedMessage(transport, 's-1', 's-target', '模型没配好时欠的')
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: true, transport, sessions })

  // 未读 → 应触发重发
  await redeliverer.onAgentCreated('s-target')

  assert.equal(sessions.calls.length, 1, '应重发这条未处理消息')
  assert.equal(sessions.calls[0].sessionId, 's-target')
  assert.equal(sessions.calls[0].mode, 'steer', '无 deliveryMode 时默认 steer')
  assert.match(sessions.calls[0].text, /模型没配好时欠的/, '重发的是原消息正文')
})

test('已被读的消息不重发（已处理 = 不再打扰）', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  const seeded = await seedMessage(transport, 's-1', 's-target', '已被处理')
  // 模拟接收方读过（markRead）
  await transport.markRead('s-target', [seeded.id])
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: true, transport, sessions })

  await redeliverer.onAgentCreated('s-target')
  assert.equal(sessions.calls.length, 0, '已读的消息不该重发')
})

test('同一轮激活内同一条不重复推（clearRound 前 recent 去重）', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  await seedMessage(transport, 's-1', 's-target', '只发一次')
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: true, maxAttempts: 5, transport, sessions })

  // 同一轮激活内连调两次（模拟宿主事件重放/并发）
  await redeliverer.onAgentCreated('s-target')
  await redeliverer.onAgentCreated('s-target')

  assert.equal(sessions.calls.length, 1, '同一轮激活内同一条只推一次')
})

test('超过 maxAttempts 后放弃，不再推', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  await seedMessage(transport, 's-1', 's-target', '始终没处理')
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: true, maxAttempts: 2, transport, sessions })

  // 第一轮激活：推 1 次（attempts=1）
  await redeliverer.onAgentCreated('s-target')
  redeliverer.clearRound()
  // 第二轮（消息仍未读，模型还是没好，但每次激活都该试到上限为止）
  await redeliverer.onAgentCreated('s-target')
  redeliverer.clearRound()
  // 第三轮：已达 maxAttempts=2，放弃
  await redeliverer.onAgentCreated('s-target')
  redeliverer.clearRound()

  assert.equal(sessions.calls.length, 2, '最多重发 maxAttempts 次')
})

test('重发模式从消息 meta.deliveryMode 解析（followup）', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  await seedMessage(transport, 's-1', 's-target', '冷启动用 followup', { deliveryMode: 'followup' })
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: true, transport, sessions })

  await redeliverer.onAgentCreated('s-target')
  assert.equal(sessions.calls.length, 1)
  assert.equal(sessions.calls[0].mode, 'followup', '应沿用 meta.deliveryMode')
})

test('空 id 的 agent 事件直接跳过', async () => {
  const transport = new InProcessTransport()
  await transport.init()
  await seedMessage(transport, 's-1', 's-target', 'x')
  const sessions = fakeSessions()
  const redeliverer = makeRedeliverer({ enabled: true, transport, sessions })

  await redeliverer.onAgentCreated('')
  assert.equal(sessions.calls.length, 0)
})