/**
 * 测试 18：**回传守卫**（机制，不靠提示词）。
 *
 * 用户的明确要求：「这个我希望能够在插件环节就直接避免，而不是让 agent
 * 每次都要靠提示词提醒才记得回传。」
 *
 * 所以修法从「在消息里写怎么回复」升级成「在轮次边界上主动介入」：
 *   ① 消息被取走 → 记欠账
 *   ② 调了 dsh_bus_send / dsh_bus_reply 且命中债主 → 销账
 *   ③ 轮次要结束时还欠着 → 把催办注入它的收件箱，让它继续跑一轮
 *
 * 关键取舍：**催，不代回**。代回会伪造对方的发言，那比不回更糟。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplyGuard, defaultNudgeText } from '../src/router/reply-guard.ts'

const ME = 'session-me-0001'
const SENDER = 'session-sender-0002'

function message(overrides = {}) {
  return {
    id: 'msg-001',
    fromId: SENDER,
    fromName: '管线维护',
    toId: ME,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────
// ① 记账
// ─────────────────────────────────────────────────────────────

test('收到别人的消息 → 记一笔欠账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())

  const pending = guard.pending(ME)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].messageId, 'msg-001')
  assert.equal(pending[0].replyToId, SENDER)
  assert.equal(pending[0].replyToName, '管线维护')
  assert.equal(pending[0].nudges, 0)
})

test('自己发给自己的消息 → 不记欠账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message({ fromId: ME }))
  assert.equal(guard.pending(ME).length, 0)
})

test('收件人不是它 → 不记（防御）', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message({ toId: 'someone-else' }))
  assert.equal(guard.pending(ME).length, 0)
})

test('缺 id 或缺 fromId → 不记，不抛', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message({ id: '' }))
  guard.onMessageClaimed(ME, message({ fromId: '' }))
  guard.onMessageClaimed('', message())
  assert.equal(guard.pending().length, 0)
})

test('多条消息各记各的', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message({ id: 'm1' }))
  guard.onMessageClaimed(ME, message({ id: 'm2' }))
  guard.onMessageClaimed(ME, message({ id: 'm3' }))
  assert.equal(guard.pending(ME).length, 3)
})

// ─────────────────────────────────────────────────────────────
// ② 销账
// ─────────────────────────────────────────────────────────────

test('用 dsh_bus_reply 且 replyTo 命中 → 销账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onToolResult(ME, 'dsh_bus_reply', { replyTo: 'msg-001', text: '收到' })
  assert.equal(guard.pending(ME).length, 0)
})

test('用 dsh_bus_send 且 to 命中债主 id → 销账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onToolResult(ME, 'dsh_bus_send', { to: SENDER, text: '收到' })
  assert.equal(guard.pending(ME).length, 0)
})

test('用 dsh_bus_send 且 to 命中债主名字 → 也销账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onToolResult(ME, 'dsh_bus_send', { to: '管线维护', text: '收到' })
  assert.equal(guard.pending(ME).length, 0)
})

test('发给了别人（不是债主）→ 不销账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onToolResult(ME, 'dsh_bus_send', { to: 'session-other', text: 'hi' })
  assert.equal(guard.pending(ME).length, 1, '债还在')
})

test('调了无关工具 → 不销账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onToolResult(ME, 'ops_bash', { command: 'ls' })
  guard.onToolResult(ME, 'write', { path: 'x' })
  assert.equal(guard.pending(ME).length, 1)
})

test('别人的会话调 reply 不能销我的账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onToolResult('session-other', 'dsh_bus_reply', { replyTo: 'msg-001' })
  assert.equal(guard.pending(ME).length, 1, '账按会话隔离')
})

test('多条欠账：回一条只销对应那条', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message({ id: 'm1' }))
  guard.onMessageClaimed(ME, message({ id: 'm2' }))
  guard.onToolResult(ME, 'dsh_bus_reply', { replyTo: 'm1' })
  const left = guard.pending(ME)
  assert.equal(left.length, 1)
  assert.equal(left[0].messageId, 'm2')
})

// ─────────────────────────────────────────────────────────────
// ③ 轮次结束催办（核心机制）
// ─────────────────────────────────────────────────────────────

test('轮次要结束还欠着 → 返回该催的欠账', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  const due = guard.onTurnStopping(ME)
  assert.equal(due.length, 1)
  assert.equal(due[0].messageId, 'msg-001')
  assert.equal(due[0].nudges, 1, '催了一次要记上')
})

test('没欠账 → 不催（不打扰正常对话）', () => {
  const guard = new ReplyGuard()
  assert.deepEqual(guard.onTurnStopping(ME), [])
})

test('催了之后再结束 → 还会催（直到上限）', () => {
  const guard = new ReplyGuard({ maxNudges: 3 })
  guard.onMessageClaimed(ME, message())

  assert.equal(guard.onTurnStopping(ME).length, 1, '第 1 次')
  assert.equal(guard.onTurnStopping(ME).length, 1, '第 2 次')
  assert.equal(guard.onTurnStopping(ME).length, 1, '第 3 次')
  assert.equal(guard.onTurnStopping(ME).length, 0, '到上限后放弃')
})

test('到上限后销账，避免无限循环', () => {
  const warnings = []
  const guard = new ReplyGuard({
    maxNudges: 1,
    logger: { warn: (m) => warnings.push(m) },
  })
  guard.onMessageClaimed(ME, message())
  guard.onTurnStopping(ME) // 第 1 次催
  guard.onTurnStopping(ME) // 到上限，放弃
  assert.equal(guard.pending(ME).length, 0, '不该一直挂着')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /仍未回复/)
})

test('催办期间回复了 → 不再催', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onTurnStopping(ME)
  guard.onToolResult(ME, 'dsh_bus_reply', { replyTo: 'msg-001' })
  assert.deepEqual(guard.onTurnStopping(ME), [], '已销账，不该再催')
})

test('催办按会话隔离：催我不催别人', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message())
  guard.onMessageClaimed('session-other', message({ toId: 'session-other', id: 'm-other' }))
  assert.equal(guard.onTurnStopping(ME).length, 1)
  assert.equal(guard.onTurnStopping('session-other').length, 1)
  assert.equal(guard.onTurnStopping('session-third').length, 0)
})

// ─────────────────────────────────────────────────────────────
// 催办文案
// ─────────────────────────────────────────────────────────────

test('催办文案给出具体工具与参数（照做即可）', () => {
  const text = defaultNudgeText({
    messageId: 'msg-001',
    replyToId: SENDER,
    replyToName: '管线维护',
    at: 0,
    nudges: 1,
  })
  assert.match(text, /dsh_bus_reply/)
  assert.match(text, /replyTo: "msg-001"/)
  assert.match(text, /dsh_bus_send/)
  assert.match(text, new RegExp(SENDER))
  assert.match(text, /管线维护/)
})

test('催办文案给「不需要回复」的出口（不强迫回复）', () => {
  const text = defaultNudgeText({
    messageId: 'm', replyToId: 's', replyToName: 'n', at: 0, nudges: 1,
  })
  assert.match(text, /不需要回复/)
  assert.match(text, /不会再来/)
})

test('可以自定义催办文案（测试注入路径）', () => {
  const guard = new ReplyGuard({ nudgeText: (d) => `CUSTOM:${d.messageId}` })
  const text = guard.nudgeText({ messageId: 'm9', replyToId: 's', replyToName: 'n', at: 0, nudges: 1 })
  assert.equal(text, 'CUSTOM:m9')
})

// ─────────────────────────────────────────────────────────────
// 边界
// ─────────────────────────────────────────────────────────────

test('reset 清空全部欠账（热重载用）', () => {
  const guard = new ReplyGuard()
  guard.onMessageClaimed(ME, message({ id: 'm1' }))
  guard.onMessageClaimed(ME, message({ id: 'm2' }))
  guard.reset()
  assert.equal(guard.pending().length, 0)
})

test('空 sessionId 调任何方法都不抛', () => {
  const guard = new ReplyGuard()
  assert.doesNotThrow(() => {
    guard.onMessageClaimed('', message())
    guard.onToolResult('', 'dsh_bus_send', {})
    guard.onTurnStopping('')
  })
})
