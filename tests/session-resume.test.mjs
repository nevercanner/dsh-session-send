/**
 * 测试 12：**未激活会话的冷启动投递**（真实痛点回归）。
 *
 * 场景：用户说「loop 项目下 7 个会话都打开着」，但重启后宿主只激活了 1 个，
 * 另外 6 个只是磁盘记录（`live: false`）。原实现只列活 Agent，于是：
 *   · 注册表里查不到那 6 个 → `E_TARGET_NOT_FOUND`
 *   · 用户会以为插件坏了
 *
 * 现在必须做到：
 *   ① 注册表把「磁盘有记录但未激活」的会话也列出来，`status` 标为 `inactive`
 *   ② 投递时尝试 `agentLoop.resume` 冷启动它，成功则真的把消息推进去
 *   ③ 冷启动失败也不能丢消息 —— 落库并如实报告
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionsProvider } from '../src/registry/dsh-sessions.ts'
import { SessionPusher } from '../src/transport/session-push.ts'
import { CompositeRegistry } from '../src/registry/registry.ts'
import { createRouter } from '../src/router/index.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { DEFAULT_CONFIG } from '../src/config/schema.ts'

/** 测试用的项目根（所有假会话的 cwd 都在它下面）。 */
const LOOP_ROOT = 'D:\\openclaw-data\\agents\\shared\\SOP\\loop'

/** 假会话记录（sessionQuery 的形状）。 */
function record(id, options = {}) {
  return {
    header: { id, cwd: options.cwd ?? 'D:\\openclaw-data\\agents\\shared\\SOP\\loop', title: options.title, createdAt: 1 },
    live: options.live ?? false,
    persisted: true,
    formatStatus: 'current',
  }
}

/** 假 Agent。 */
function fakeAgent(id, options = {}) {
  const calls = []
  return {
    id,
    calls,
    // 真实 Agent 的标题在 session.header 上；注册表读的就是这个
    session: { header: { id, title: options.title, cwd: options.cwd ?? 'D:\\openclaw-data\\agents\\shared\\SOP\\loop' } },
    steer: (input) => calls.push({ via: 'steer', input }),
    followup: (input) => calls.push({ via: 'followup', input }),
    inject: (input) => calls.push({ via: 'inject', input }),
    send: (input, target) => calls.push({ via: `send:${target}`, input }),
  }
}

/** 假宿主：agents（活）+ sessionQuery（磁盘）+ agentLoop（冷启动）。 */
function host({ liveAgents = {}, persisted = [], resumeImpl } = {}) {
  return {
    get(name) {
      if (name === 'agents') {
        return {
          list: () => Object.values(liveAgents),
          get: (id) => liveAgents[id],
        }
      }
      if (name === 'sessionQuery') {
        return { listSessions: async () => persisted }
      }
      if (name === 'agentLoop') {
        return {
          resume: async (_ownerCtx, options) => {
            if (resumeImpl === undefined) throw new Error('no resume configured')
            return resumeImpl(options.resumeSessionId)
          },
        }
      }
      return undefined
    },
  }
}

// ─────────────────────────────────────────────────────────────
// ① 注册表：活 + 未激活都要列
// ─────────────────────────────────────────────────────────────

test('注册表：活 Agent 与磁盘记录都列出，status 区分 live / inactive', async () => {
  const liveA = fakeAgent('s-live', { title: '活的那个' })
  const ctx = host({
    liveAgents: { 's-live': liveA },
    persisted: [
      record('s-live', { live: true, title: '活的那个' }),
      record('s-idle-1', { live: false, title: '跑章选手' }),
      record('s-idle-2', { live: false, title: '门禁' }),
    ],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP_ROOT })
  const entries = await provider.list()

  assert.equal(entries.length, 3, '活 1 + 未激活 2')
  const live = entries.find((e) => e.id === 's-live')
  assert.equal(live.status, 'live')
  assert.equal(live.name, '活的那个')

  const idle1 = entries.find((e) => e.id === 's-idle-1')
  assert.equal(idle1.status, 'inactive')
  assert.equal(idle1.name, '跑章选手', '未激活的会话也应该显示它的标题')

  const idle2 = entries.find((e) => e.id === 's-idle-2')
  assert.equal(idle2.status, 'inactive')
})

test('注册表：resolve 也能命中未激活会话（这是之前 E_TARGET_NOT_FOUND 的根因）', async () => {
  const ctx = host({
    liveAgents: {},
    persisted: [record('s-idle-1', { title: '跑章选手' })],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP_ROOT })

  const byId = await provider.resolve('s-idle-1')
  assert.equal(byId.length, 1)
  assert.equal(byId[0].status, 'inactive')

  const byName = await provider.resolve('跑章选手')
  assert.equal(byName.length, 1)
  assert.equal(byName[0].id, 's-idle-1')
})

test('注册表：sessionQuery 缺席时只列活 Agent（不报错）', async () => {
  const ctx = {
    get: (name) =>
      name === 'agents' ? { list: () => [fakeAgent('s-live')], get: (id) => (id === 's-live' ? fakeAgent('s-live') : undefined) } : undefined,
  }
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP_ROOT })
  const entries = await provider.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'live')
})

test('注册表：同一 id 出现两次时，活 Agent 优先（不重复）', async () => {
  const ctx = host({
    liveAgents: { 's-1': fakeAgent('s-1') },
    persisted: [record('s-1', { live: true }), record('s-1', { live: false })],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP_ROOT })
  const entries = await provider.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'live')
})

// ─────────────────────────────────────────────────────────────
// ② 投递：未激活 → 冷启动 → 真的推进去
// ─────────────────────────────────────────────────────────────

test('投递未激活会话：冷启动成功后 steer 生效（这是「7 个会话」的关键）', async () => {
  const revived = fakeAgent('s-idle-1')
  const ctx = host({
    liveAgents: {},
    persisted: [record('s-idle-1')],
    resumeImpl: (id) => (id === 's-idle-1' ? { agent: revived } : undefined),
  })
  const pusher = new SessionPusher({ ctx })
  const result = await pusher.push('s-idle-1', '请跑第三章', 'steer')

  assert.equal(result.live, true)
  // 冷启动后 steer 不可靠（phase 处于过渡态，wakeDriver 只设 wakeRequested），
  // 因此自动降级为 followup —— 语义上仍然是「叫醒它并处理这条」。
  assert.equal(result.outcome, 'queued')
  assert.match(String(result.detail), /冷启动/)
  assert.equal(revived.calls.length, 1, '冷启动后必须真的收到')
  assert.equal(revived.calls[0].via, 'followup', '冷启动路径用 followup（实测稳定）')
})

test('已激活的会话仍然用 steer（不降级）', async () => {
  const liveAgent = fakeAgent('s-live')
  const ctx = host({ liveAgents: { 's-live': liveAgent }, persisted: [record('s-live', { live: true })] })
  const pusher = new SessionPusher({ ctx })
  const result = await pusher.push('s-live', 'x', 'steer')

  assert.equal(result.outcome, 'steered')
  assert.equal(liveAgent.calls[0].via, 'steer', '本来就活着的不该降级')
})

test('投递未激活会话：冷启动失败 → durable，消息不丢', async () => {
  const ctx = host({
    liveAgents: {},
    persisted: [record('s-idle-1')],
    resumeImpl: () => {
      throw new Error('cannot resume')
    },
  })
  const pusher = new SessionPusher({ ctx })
  const result = await pusher.push('s-idle-1', 'x', 'steer')

  assert.equal(result.live, false)
  assert.equal(result.outcome, 'absent')
  assert.match(String(result.detail), /冷启动失败|无法冷启动/)
})

test('投递未激活会话：宿主没有 agentLoop → durable，不抛', async () => {
  const ctx = {
    get: (name) => (name === 'agents' ? { list: () => [], get: () => undefined } : undefined),
  }
  const pusher = new SessionPusher({ ctx })
  const result = await pusher.push('s-any', 'x', 'steer')
  assert.equal(result.outcome, 'absent')
  assert.match(String(result.detail), /agentLoop/)
})

test('resume:false 显式禁用冷启动：不去碰 agentLoop', async () => {
  let resumeCalled = false
  const ctx = host({
    liveAgents: {},
    persisted: [],
    resumeImpl: () => {
      resumeCalled = true
      return undefined
    },
  })
  const pusher = new SessionPusher({ ctx })
  const result = await pusher.push('s-any', 'x', 'steer', { resume: false })
  assert.equal(result.outcome, 'absent')
  assert.equal(resumeCalled, false, 'resume:false 时不该尝试冷启动')
})

// ─────────────────────────────────────────────────────────────
// ③ 端到端：模拟「7 个会话，只有 1 个活着」
// ─────────────────────────────────────────────────────────────

test('端到端：7 个 loop 会话只激活 1 个，仍能发给其余 6 个（冷启动）', async () => {
  const ids = ['pipeline', 'runner', 'gate', 'writer', 'checker', 'arbiter', 'editor']
  const live = { pipeline: fakeAgent('pipeline') } // 只有它活着
  const revived = {}
  for (const id of ids.filter((x) => x !== 'pipeline')) revived[id] = fakeAgent(id)

  const ctx = host({
    liveAgents: live,
    persisted: ids.map((id) => record(id, { live: id === 'pipeline', title: id })),
    resumeImpl: (id) => (revived[id] ? { agent: revived[id] } : undefined),
  })

  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP_ROOT })
  const registry = new CompositeRegistry([provider])
  const transport = new InProcessTransport()
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport,
    registry,
    sessions: new SessionPusher({ ctx }),
  })

  // 7 个都在注册表里
  const all = await registry.list()
  assert.equal(all.length, 7)
  assert.equal(all.filter((e) => e.status === 'live').length, 1)
  assert.equal(all.filter((e) => e.status === 'inactive').length, 6)

  // 管线维护 → 跑章选手（未激活，需要冷启动 → 自动降级 followup）
  const receipt = await router.send({ from: 'pipeline', to: 'runner', payload: '第三章管线就绪' })
  assert.equal(receipt.deliveries[0].mode, 'queued', '冷启动路径按 followup 投递')
  assert.equal(revived.runner.calls.length, 1, '跑章选手必须被冷启动并收到')

  // 跑章选手 → 门禁（另一个未激活）
  const second = await router.send({ from: 'runner', to: 'gate', payload: '第三章完成，请复核' })
  assert.equal(second.deliveries[0].mode, 'queued')
  assert.equal(revived.gate.calls.length, 1, '门禁必须被冷启动并收到')

  // 其余没被碰过的保持静默
  assert.equal(revived.writer.calls.length, 0)
  assert.equal(revived.editor.calls.length, 0)
})
