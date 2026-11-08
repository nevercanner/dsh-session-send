/**
 * 测试 1：路由语义（对齐 openclaw session send 的**做法**）。
 *
 * 覆盖：单播 / 目标不存在显式报错 / 广播（共享 broadcastId）/ request-response 关联 /
 *       缺 replyTo 拒绝 / 非 request 的 replyTo 允许 / 未读计数 / 空 payload / 广播开关 / 广播空目标。
 *
 * 只用 in-process transport（快速、无磁盘副作用），每个用例独立上下文。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../src/router/index.ts'
import { CompositeRegistry } from '../src/registry/registry.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { DEFAULT_CONFIG } from '../src/config/schema.ts'

function fakeProvider(entries) {
  return {
    source: 'dsh-sessions',
    async available() {
      return true
    },
    async list() {
      return entries
    },
    async resolve(ref) {
      return entries.filter((entry) => entry.id === ref || entry.name === ref)
    },
  }
}

function context(entries, overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    ...overrides,
    router: { ...DEFAULT_CONFIG.router, ...(overrides.router ?? {}) },
  }
  const transport = new InProcessTransport()
  const registry = new CompositeRegistry([fakeProvider(entries)])
  const router = createRouter({ config, transport, registry })
  return { config, transport, registry, router }
}

const people = [
  { id: 's-1', name: 'alpha', kind: 'session', source: 'dsh-sessions' },
  { id: 's-2', name: 'beta', kind: 'session', source: 'dsh-sessions' },
]

test('单播：发给 agent 名字，落到对端', async () => {
  const { router, transport } = context(people)
  const receipt = await router.send({ from: 's-1', to: 'beta', payload: 'hello beta' })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.messages.length, 1)
  assert.equal(receipt.messages[0].toId, 's-2')
  assert.equal(receipt.messages[0].toName, 'beta')
  const inbox = await transport.list({ to: 's-2' })
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].payload.text, 'hello beta')
})

test('单播：也接受 session id', async () => {
  const { router } = context(people)
  const receipt = await router.send({ from: 'alpha', to: 's-2', payload: { text: 'by id' } })
  assert.equal(receipt.messages[0].toId, 's-2')
})

test('目标不存在：抛 E_TARGET_NOT_FOUND，不静默丢弃', async () => {
  const { router, transport } = context(people)
  await assert.rejects(
    () => router.send({ from: 's-1', to: 'ghost', payload: 'x' }),
    (error) => error.code === 'E_TARGET_NOT_FOUND',
  )
  assert.equal((await transport.list({ limit: 100 })).length, 0)
})

test('广播：每个目标一条，共享 broadcastId，且跳过发送方', async () => {
  const { router } = context(people)
  const receipt = await router.send({ from: 's-1', to: '*', payload: 'all hands' })
  assert.equal(receipt.messages.length, 1, '只有 beta 一个目标')
  assert.deepEqual(
    receipt.messages.map((message) => message.toId),
    ['s-2'],
  )
  const group = await router.send({ from: 's-1', to: '*', payload: 'again' })
  assert.equal(group.messages[0].broadcastId !== undefined, true)
})

test('广播：多个目标时 broadcastId 相同、message id 各不相同', async () => {
  const three = [...people, { id: 's-3', name: 'gamma', kind: 'session', source: 'dsh-sessions' }]
  const { router } = context(three)
  const receipt = await router.send({ from: 's-1', to: '*', payload: 'fan out' })
  assert.equal(receipt.messages.length, 2)
  assert.equal(new Set(receipt.messages.map((message) => message.broadcastId)).size, 1)
  assert.equal(new Set(receipt.messages.map((message) => message.id)).size, 2)
})

test('request-response：replyTo 指回原 request', async () => {
  const { router } = context(people)
  const request = await router.send({ from: 's-1', to: 'beta', kind: 'request', payload: 'status?' })
  const requestId = request.messages[0].id
  const response = await router.send({
    from: 's-2',
    to: 'alpha',
    kind: 'response',
    payload: 'all good',
    replyTo: requestId,
  })
  assert.equal(response.messages[0].replyTo, requestId)
  assert.equal(response.messages[0].kind, 'response')
})

test('response 缺 replyTo：抛 E_REPLY_TARGET_MISSING', async () => {
  const { router } = context(people)
  await assert.rejects(
    () => router.send({ from: 's-2', to: 'alpha', kind: 'response', payload: 'orphan' }),
    (error) => error.code === 'E_REPLY_TARGET_MISSING',
  )
})

test('replyTo 指向不存在的消息：拒绝', async () => {
  const { router } = context(people)
  await assert.rejects(
    () => router.send({ from: 's-2', to: 'alpha', kind: 'response', payload: 'x', replyTo: 'nope' }),
    (error) => error.code === 'E_REPLY_TARGET_MISSING',
  )
})

test('回复一条 text（非 request）：允许，并把原 kind 记进 meta', async () => {
  const { router } = context(people)
  const plain = await router.send({ from: 's-1', to: 'beta', payload: 'not a request' })
  const reply = await router.send({
    from: 's-2',
    to: 'alpha',
    kind: 'response',
    payload: 'replying to a text',
    replyTo: plain.messages[0].id,
  })
  assert.equal(reply.messages[0].replyTo, plain.messages[0].id)
  assert.equal(reply.messages[0].meta?.originalKind, 'text')
})

test('未读数：发送方自己的消息不算自己的未读，读后归零', async () => {
  const { router, transport } = context(people)
  await router.send({ from: 's-1', to: 'beta', payload: 'one' })
  await router.send({ from: 's-1', to: 'beta', payload: 'two' })
  assert.equal((await transport.unread(['s-2']))[0].count, 2)
  assert.equal((await transport.unread(['s-1']))[0].count, 0)
  const inbox = await transport.list({ to: 's-2' })
  await router.markRead('s-2', inbox.map((message) => message.id))
  assert.equal((await transport.unread(['s-2']))[0].count, 0)
})

test('空 payload 与超长 payload 分别报错', async () => {
  const { router } = context(people, { router: { maxPayloadChars: 10 } })
  await assert.rejects(
    () => router.send({ from: 's-1', to: 'beta', payload: '   ' }),
    (error) => error.code === 'E_PAYLOAD_EMPTY',
  )
  await assert.rejects(
    () => router.send({ from: 's-1', to: 'beta', payload: 'x'.repeat(11) }),
    (error) => error.code === 'E_PAYLOAD_TOO_LARGE',
  )
})

test('allowBroadcast=false：广播被拒 E_BROADCAST_DISABLED', async () => {
  const { router } = context(people, { router: { allowBroadcast: false } })
  await assert.rejects(
    () => router.send({ from: 's-1', to: '*', payload: 'x' }),
    (error) => error.code === 'E_BROADCAST_DISABLED',
  )
})

test('广播无目标：抛 E_BROADCAST_EMPTY', async () => {
  const solo = [{ id: 's-1', name: 'alpha', kind: 'session', source: 'dsh-sessions' }]
  const { router } = context(solo)
  await assert.rejects(
    () => router.send({ from: 's-1', to: '*', payload: 'x' }),
    (error) => error.code === 'E_BROADCAST_EMPTY',
  )
})

test('歧义目标：命中多个身份时抛 E_AMBIGUOUS_TARGET 并列出候选', async () => {
  const ambiguous = [
    { id: 'x-1', name: 'twin', kind: 'agent', source: 'dsh-sessions' },
    { id: 'x-2', name: 'twin', kind: 'agent', source: 'dsh-sessions' },
  ]
  const { router } = context(ambiguous)
  await assert.rejects(
    () => router.send({ from: 'x-1', to: 'twin', payload: 'x' }),
    (error) => error.code === 'E_AMBIGUOUS_TARGET' && Array.isArray(error.detail?.candidates),
  )
})

test('history / snapshot：按会话视角取消息，并带来源可用性', async () => {
  const { router } = context(people)
  await router.send({ from: 's-1', to: 'beta', payload: 'visible to both' })
  const mine = await router.history({ involving: 's-2' })
  assert.equal(mine.length, 1)
  const snapshot = await router.snapshot('s-2', 10)
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.agents.length, 2)
  assert.equal(snapshot.messages.length, 1)
  assert.equal(snapshot.sources[0].available, true)
})
