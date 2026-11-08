/**
 * 测试 19：**新会话接入**（用户提的三个问题）。
 *
 * 用户的疑问：
 *   ① 新会话是自动接入还是手动开？
 *   ② 新会话怎么知道自己是「谁」、消息发给谁？
 *   ③ 默认全接入会打扰不相关的会话，能不能按需接入？
 *
 * 设计答案：
 *   ① 接入自动（项目开关控制），但**参与**需要报名 —— 报名 = 参与
 *   ② 首次被投递时，正文前面附一段自我介绍（我是谁、还有谁、怎么回）
 *   ③ `registry.requireRegistration`（默认 true）：没报名的会话完全不可见
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readGreeted,
  markGreeted,
  buildGreeting,
  greetingFor,
  greetedPathFor,
  GREETED_FILE,
} from '../src/registry/onboarding.ts'
import { writeName } from '../src/registry/names.ts'
import { DshSessionsProvider } from '../src/registry/dsh-sessions.ts'

const LOOP = 'D:\\openclaw-data\\agents\\shared\\SOP\\loop'

function rec(id, options = {}) {
  return {
    header: { id, cwd: options.cwd ?? LOOP, title: options.title, createdAt: 1794124151026 },
    live: options.live ?? true,
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
// ③ 报名 = 参与（你的担心：不打扰无关会话）
// ─────────────────────────────────────────────────────────────

test('未报名的会话不出现在列表里（默认不打扰）', async () => {
  const ctx = host({
    persisted: [
      rec('session-registered'),
      rec('session-stranger'),
      rec('session-stranger-2'),
    ],
  })
  const dir = await mkdtemp(join(tmpdir(), 'onboard-'))
  try {
    await writeName(dir, 'session-registered', '管线维护')

    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })
    // 注意：会话 cwd 是 LOOP，项目根是 dir —— 用 LOOP 做项目根才对
    const provider2 = new DshSessionsProvider({
      ctx,
      projectRoot: LOOP,
      labels: { 'session-registered': '管线维护' },
    })
    const entries = await provider2.list()
    assert.equal(entries.length, 1, '只有报名的那个可见')
    assert.equal(entries[0].id, 'session-registered')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('未报名的会话连 id 也不能寻址（否则绕过了不打扰）', async () => {
  const ctx = host({ persisted: [rec('session-stranger')] })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP })
  assert.equal((await provider.resolve('session-stranger')).length, 0)
})

test('requireRegistration: false → 全部可见（小项目用）', async () => {
  const ctx = host({ persisted: [rec('a'), rec('b'), rec('c')] })
  const provider = new DshSessionsProvider({ ctx, projectRoot: LOOP, requireRegistration: false })
  assert.equal((await provider.list()).length, 3)
  assert.equal((await provider.resolve('a')).length, 1, 'id 也能寻址')
})

test('listAll 能看到未报名的（用于诊断「还有多少没接入」）', async () => {
  const ctx = host({ persisted: [rec('session-registered'), rec('session-stranger')] })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: LOOP,
    labels: { 'session-registered': 'x' },
  })
  assert.equal((await provider.list()).length, 1, 'list 只列参与者的')
  assert.equal((await provider.listAll()).length, 2, 'listAll 含未报名')
})

// ─────────────────────────────────────────────────────────────
// ② 首次投递附自我介绍
// ─────────────────────────────────────────────────────────────

test('greeted 记录：文件不存在返回空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greet-'))
  try {
    assert.deepEqual(await readGreeted(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('greeted 记录：标记后能读回，存在项目内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greet-'))
  try {
    await markGreeted(dir, 'session-a')
    const greeted = await readGreeted(dir)
    assert.equal(typeof greeted['session-a'], 'number')
    assert.equal(greetedPathFor(dir), join(dir, '.dsh-bus', GREETED_FILE))
    assert.equal(existsSync(greetedPathFor(dir)), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('首次投递给介绍，第二次不再给（只出现一次）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greet-'))
  try {
    const roster = [{ name: 'cast' }, { name: 'gate' }]

    const first = await greetingFor({
      projectRoot: dir,
      targetId: 'session-new',
      targetName: 'chapter',
      roster,
    })
    assert.notEqual(first, undefined, '第一次应该给介绍')

    const second = await greetingFor({
      projectRoot: dir,
      targetId: 'session-new',
      targetName: 'chapter',
      roster,
    })
    assert.equal(second, undefined, '第二次不该再给')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('介绍内容回答三个问题：我是谁 / 还有谁 / 怎么回', () => {
  const text = buildGreeting({
    selfName: 'chapter',
    roster: [{ name: 'cast' }, { name: 'gate' }],
  })

  assert.match(text, /你在总线里的名字：\*\*chapter\*\*/, '我是谁')
  assert.match(text, /cast/, '还有谁')
  assert.match(text, /gate/, '还有谁')
  assert.match(text, /dsh_bus_send/, '怎么发')
  assert.match(text, /dsh_bus_reply/, '怎么回')
  assert.match(text, /dsh_bus_agents/, '怎么看完整名册')
})

test('还没报名的会话：介绍里告诉它怎么报名', () => {
  const text = buildGreeting({ roster: [] })
  assert.match(text, /你还没有在总线里报名/)
  assert.match(text, /dsh_bus_register/)
})

test('通讯录不包含自己（避免"给自己发消息"的困惑）', () => {
  const text = buildGreeting({
    selfName: 'chapter',
    roster: [{ name: 'chapter' }, { name: 'gate' }],
  })
  // gate 应该在，但 chapter 不该以"其它会话"的身份出现
  assert.match(text, /gate/)
  const rosterSection = text.split('本项目已接入的其它会话：')[1] ?? ''
  assert.equal(rosterSection.includes('· chapter'), false, '自己不该出现在通讯录里')
})

test('单会话项目：明说"只有你一个"', () => {
  const text = buildGreeting({ selfName: 'solo', roster: [] })
  assert.match(text, /只有你一个会话报名/)
})

test('介绍标记按项目隔离：A 介绍过不影响 B', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'greet-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'greet-b-'))
  try {
    await markGreeted(dirA, 'session-x')
    const greetedA = await readGreeted(dirA)
    const greetedB = await readGreeted(dirB)
    assert.notEqual(greetedA['session-x'], undefined, 'A 有记录')
    assert.equal(greetedB['session-x'], undefined, 'B 项目不该受影响')
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('介绍写进 greeted.json，内容可审计', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greet-'))
  try {
    await markGreeted(dir, 'session-a')
    const raw = JSON.parse(await readFile(greetedPathFor(dir), 'utf8'))
    assert.equal(typeof raw['session-a'], 'number', '记录的是时间戳，可查何时介绍的')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
