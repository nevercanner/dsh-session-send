/**
 * 测试 16：**会话自注册**（解决「不写死、可推广」）。
 *
 * 用户的核心反馈：不能在配置里手写 session id 映射 —— 插件是要推广的，
 * 其他项目也要能用，不能要求每个项目都手工维护一张 uuid 表。
 *
 * 方案：会话自己调 `dsh_bus_register({ name: "管线维护" })` 报名。
 *   · 名册存**项目内** `.dsh-bus/names.json`，不跨项目泄漏
 *   · 报名后立刻生效（列表与 to 解析都认）
 *   · 不需要任何人事先知道 session id
 *
 * 优先级：自注册名 > 配置 labels > 宿主 title > 兜底名
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNames, writeName, nameOf, namesPathFor, NAMES_FILE } from '../src/registry/names.ts'
import { DshSessionsProvider } from '../src/registry/dsh-sessions.ts'

const PROJECT = 'D:\\proj'

function rec(id, options = {}) {
  return {
    header: {
      id,
      cwd: options.cwd ?? PROJECT,
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
// 名册读写
// ─────────────────────────────────────────────────────────────

test('名册：文件不存在时返回空对象，不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    assert.deepEqual(await readNames(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：写入后能读回，存在项目内的 .dsh-bus/names.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await writeName(dir, 'session-a', '管线维护')
    const names = await readNames(dir)
    assert.deepEqual(Object.keys(names), ['session-a'])
    assert.equal(names['session-a'].name, '管线维护')
    assert.equal(typeof names['session-a'].at, 'number')

    // 文件真的在项目内
    const file = namesPathFor(dir)
    assert.equal(file, join(dir, '.dsh-bus', NAMES_FILE))
    assert.equal(existsSync(file), true)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw['session-a'].name, '管线维护')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：多次写入累加，不覆盖别人', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await writeName(dir, 'a', '管线维护')
    await writeName(dir, 'b', '跑章选手')
    await writeName(dir, 'c', '门禁')
    const names = await readNames(dir)
    assert.equal(Object.keys(names).length, 3)
    assert.equal(names['b'].name, '跑章选手')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：改名覆盖旧名', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await writeName(dir, 'a', '旧名字')
    await writeName(dir, 'a', '新名字')
    assert.equal((await readNames(dir))['a'].name, '新名字')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：空名字 = 清除登记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await writeName(dir, 'a', '临时名')
    assert.equal(Object.keys(await readNames(dir)).length, 1)
    await writeName(dir, 'a', '   ')
    assert.deepEqual(await readNames(dir), {}, '空名字应该删掉条目')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：损坏文件按空名册处理，下次写入重建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(namesPathFor(dir), '{ not valid json', 'utf8')
    assert.deepEqual(await readNames(dir), {}, '坏文件不该让注册表不可用')

    // 还能正常写入并恢复
    await writeName(dir, 'a', '恢复')
    assert.equal((await readNames(dir))['a'].name, '恢复')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：数组/非对象内容也按空处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(namesPathFor(dir), '[1,2,3]', 'utf8')
    assert.deepEqual(await readNames(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册：非法条目被过滤（缺 name / name 非字符串）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(
      namesPathFor(dir),
      JSON.stringify({
        good: { name: '正常', at: 1 },
        missingName: { at: 1 },
        badName: { name: 123, at: 1 },
        emptyName: { name: '   ', at: 1 },
      }),
      'utf8',
    )
    const names = await readNames(dir)
    assert.deepEqual(Object.keys(names), ['good'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('nameOf：取名字，空/缺失返回 undefined', () => {
  const registry = { a: { name: '甲', at: 1 }, b: { name: '   ', at: 1 } }
  assert.equal(nameOf(registry, 'a'), '甲')
  assert.equal(nameOf(registry, 'b'), undefined)
  assert.equal(nameOf(registry, 'nope'), undefined)
})

// ─────────────────────────────────────────────────────────────
// 接入 provider：优先级
// ─────────────────────────────────────────────────────────────

test('优先级：自注册名 > labels > title > 兜底', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    const ctx = host({
      persisted: [
        rec('s-registered', { cwd: dir, title: '宿主标题' }),
        rec('s-labelled', { cwd: dir, title: '宿主标题' }),
        rec('s-titled', { cwd: dir, title: '只有宿主标题' }),
        rec('s-bare', { cwd: dir }),
      ],
    })
    await writeName(dir, 's-registered', '自注册名')

    const provider = new DshSessionsProvider({
      ctx,
      projectRoot: dir,
      labels: { 's-registered': '配置名', 's-labelled': '配置名' },
      // 不传 names：provider 每次从项目文件读
    })
    // 让会话的 cwd 与项目根一致
    const entries = await provider.list()
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.name]))

    assert.equal(byId['s-registered'], '自注册名', '自注册最优先')
    assert.equal(byId['s-labelled'], '配置名', '没有自注册时用配置')
    assert.equal(byId['s-titled'], '只有宿主标题', '再退到宿主标题')
    assert.match(byId['s-bare'], /·/, '最后是兜底名（含时间戳）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('报名后立刻生效：不需要重装配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    const ctx = host({ persisted: [rec('s-1', { cwd: dir })] })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })

    const before = await provider.list()
    assert.match(before[0].name, /·/, '报名前是兜底名')

    await writeName(dir, 's-1', '管线维护')

    const after = await provider.list()
    assert.equal(after[0].name, '管线维护', '报名后同一个 provider 实例立刻反映')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('报名后可按下名字寻址（to: "门禁"）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    const ctx = host({ persisted: [rec('s-gate', { cwd: dir }), rec('s-other', { cwd: dir })] })
    await writeName(dir, 's-gate', '门禁')

    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })
    const hits = await provider.resolve('门禁')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 's-gate')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('名册按项目隔离：A 项目的名册不影响 B 项目', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'proj-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'proj-b-'))
  try {
    await writeName(dirA, 's-a', 'A 的名字')

    const ctxA = host({ persisted: [rec('s-a', { cwd: dirA })] })
    const ctxB = host({ persisted: [rec('s-b', { cwd: dirB })] })

    const providerA = new DshSessionsProvider({ ctx: ctxA, projectRoot: dirA })
    const providerB = new DshSessionsProvider({ ctx: ctxB, projectRoot: dirB })

    const entriesA = await providerA.list()
    const entriesB = await providerB.list()

    assert.equal(entriesA[0].name, 'A 的名字')
    assert.match(entriesB[0].name, /·/, 'B 项目不该看到 A 的名册')
    assert.deepEqual(await readNames(dirB), {}, 'B 的名册是空的')
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('显式传入 names 时优先用它（测试注入路径）', async () => {
  const ctx = host({ persisted: [rec('s-1', { cwd: PROJECT })] })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: PROJECT,
    names: { 's-1': { name: '注入的名字', at: 1 } },
  })
  const [entry] = await provider.list()
  assert.equal(entry.name, '注入的名字')
})

// ─────────────────────────────────────────────────────────────
// 寻址键：id 与「绑定在 id 上的名字」可以，派生显示名不行
// ─────────────────────────────────────────────────────────────

test('寻址：session id 永远可寻址（最可靠的键）', async () => {
  const ctx = host({ persisted: [rec('session-abc', { cwd: PROJECT })] })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT })
  const hits = await provider.resolve('session-abc')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-abc')
})

test('寻址：自注册名可寻址（绑定在 id 上）', async () => {
  const ctx = host({ persisted: [rec('session-abc', { cwd: PROJECT })] })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: PROJECT,
    names: { 'session-abc': { name: '门禁', at: 1 } },
  })
  const hits = await provider.resolve('门禁')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-abc')
})

test('寻址：**派生显示名不可寻址**（真实设计缺陷回归）', async () => {
  // 用户质疑：时间戳名字会随派生逻辑变化，拿它当寻址键不可靠。
  // 正确做法是只用 id 或绑定在 id 上的名字。
  const ctx = host({ persisted: [rec('session-abc', { cwd: PROJECT, createdAt: 1794124151026 })] })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT })

  const [entry] = await provider.list()
  // 显示名确实是时间戳格式（人看的）
  assert.match(entry.name, /·/, `兜底显示名应该是时间戳格式，实际：${entry.name}`)

  // 但拿它去 resolve 必须失败
  const hits = await provider.resolve(entry.name)
  assert.equal(hits.length, 0, `派生显示名不该能寻址，实际命中了 ${hits.length} 条`)

  // id 仍然可以
  assert.equal((await provider.resolve('session-abc')).length, 1)
})

test('寻址：配置 labels 可寻址（绑定在 id 上）', async () => {
  const ctx = host({ persisted: [rec('session-abc', { cwd: PROJECT })] })
  const provider = new DshSessionsProvider({
    ctx,
    projectRoot: PROJECT,
    labels: { 'session-abc': '临时名' },
  })
  const hits = await provider.resolve('临时名')
  assert.equal(hits.length, 1)
})

test('寻址：宿主 title 可寻址（宿主正式字段）', async () => {
  const ctx = host({ persisted: [rec('session-abc', { cwd: PROJECT, title: '宿主标题' })] })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT })
  const hits = await provider.resolve('宿主标题')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-abc')
})

// ─────────────────────────────────────────────────────────────
// 批量报名（整项目一次性初始化）
// ─────────────────────────────────────────────────────────────

test('批量报名：一次写多条，都能按名字寻址', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    const ids = ['session-cast', 'session-outline', 'session-gate']
    const ctx = host({ persisted: ids.map((id) => rec(id, { cwd: dir })) })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })

    // 模拟批量写入（工具层做的事）
    await writeName(dir, 'session-cast', 'cast')
    await writeName(dir, 'session-outline', 'outline')
    await writeName(dir, 'session-gate', 'gate')

    for (const [id, name] of [['session-cast', 'cast'], ['session-outline', 'outline'], ['session-gate', 'gate']]) {
      const hits = await provider.resolve(name)
      assert.equal(hits.length, 1, `${name} 应该能解析`)
      assert.equal(hits[0].id, id)
    }

    const entries = await provider.list()
    assert.deepEqual(entries.map((e) => e.name).sort(), ['cast', 'gate', 'outline'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('批量报名：跨项目的 id 被跳过，不影响其它条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    const ctx = host({ persisted: [rec('session-a', { cwd: dir })] })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })

    // session-other 不在本项目 → resolve 返回空 → 工具层应拒绝
    assert.equal((await provider.resolve('session-other')).length, 0)
    // 本项目的可以
    assert.equal((await provider.resolve('session-a')).length, 1)

    // 只写合法的那个
    await writeName(dir, 'session-a', 'A')
    assert.equal((await provider.resolve('A')).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────
// 派生规则核实（避免误读为哈希）
// ─────────────────────────────────────────────────────────────

test('兜底名规则：就是 id 去 session- 后的最后 7 位（不是哈希）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'names-'))
  try {
    const id = 'session-da38f11a-5982-4d2c-bc3d-c5381400cf88'
    const ctx = host({ persisted: [rec(id, { cwd: dir, createdAt: 1794106364882 })] })
    const provider = new DshSessionsProvider({ ctx, projectRoot: dir })
    const [entry] = await provider.list()

    // 尾段应该是 400cf88
    assert.match(entry.name, /400cf88$/, `兜底名应以 id 最后 7 位结尾，实际：${entry.name}`)
    // 时间戳格式
    assert.match(entry.name, /^\d{2}-\d{2} \d{2}:\d{2} · /)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
