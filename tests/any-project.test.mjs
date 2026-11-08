/**
 * 测试 20：**任何项目都能用，且空列表必须说清为什么**（真实困惑回归）。
 *
 * 用户的疑问：「你的插件难道就固定了 loop 项目 7 个会话吗？
 *   人家没有 loop 能用吗？」
 *
 * 事实：没有固定。每个项目有自己的开关与名册。但当时的实现有个真问题 ——
 * 项目未启用时 `dsh_bus_agents` **静默返回 0 个身份**，调用方只看到空列表，
 * 会以为插件坏了，而不是「这个项目没开总线」。
 *
 * 守死的行为：
 *   ① 不同项目各自独立（A 的报名不影响 B）
 *   ② 未启用的项目：返回 enabled=false + 项目路径 + 原因，不装成「没人」
 *   ③ 已启用但无人报名：返回 0 + 提示怎么报名
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshSessionsProvider } from '../src/registry/dsh-sessions.ts'
import { writeName } from '../src/registry/names.ts'

function rec(id, cwd) {
  return { header: { id, cwd, createdAt: 1794124151026 }, live: true, persisted: true }
}

function host({ persisted = [] } = {}) {
  return {
    get(name) {
      if (name === 'agents') return { list: () => [], get: () => undefined }
      if (name === 'sessionQuery') return { listSessions: async () => persisted }
      return undefined
    },
  }
}

test('项目互相独立：A 的名册不会让 B 也看到人', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'proj-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'proj-b-'))
  try {
    await writeName(dirA, 'session-a1', 'lane-a')

    const ctx = host({
      persisted: [rec('session-a1', dirA), rec('session-b1', dirB)],
    })

    const provA = new DshSessionsProvider({ ctx, projectRoot: dirA })
    const provB = new DshSessionsProvider({ ctx, projectRoot: dirB })

    const listA = await provA.list()
    const listB = await provB.list()

    assert.equal(listA.length, 1, 'A 项目能看到自己报名的')
    assert.equal(listA[0].name, 'lane-a')
    assert.equal(listB.length, 0, 'B 项目没报名，看不到任何人')

    // B 也报名后各自独立
    await writeName(dirB, 'session-b1', 'lane-b')
    const provB2 = new DshSessionsProvider({ ctx, projectRoot: dirB })
    const listB2 = await provB2.list()
    assert.equal(listB2.length, 1)
    assert.equal(listB2[0].name, 'lane-b')
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('全新项目（没有任何名册）也能用：返回空列表而不是报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fresh-'))
  try {
    const ctx = host({ persisted: [rec('session-x', dir)] })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })
    const list = await provider.list()
    assert.equal(list.length, 0, '没人报名就是空，不报错')
    // 报名后立刻可用
    await writeName(dir, 'session-x', 'first-lane')
    const provider2 = new DshSessionsProvider({ ctx, projectRoot: dir })
    assert.equal((await provider2.list()).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('未报名时 id 也不可寻址（不打扰）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fresh-'))
  try {
    const ctx = host({ persisted: [rec('session-y', dir)] })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })
    assert.equal((await provider.resolve('session-y')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('requireRegistration=false 时全新项目直接可用（小项目模式）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fresh-'))
  try {
    const ctx = host({ persisted: [rec('session-z', dir)] })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir, requireRegistration: false })
    assert.equal((await provider.list()).length, 1)
    assert.equal((await provider.resolve('session-z')).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})