/**
 * 测试 13：**项目隔离**（方案 A 的核心保证）。
 *
 * 插件装配在 profile 层（全局），但「谁能看见谁、谁能发给谁」必须按项目隔离：
 *   · 注册表只列**本项目**的会话
 *   · resolve 也只认本项目
 *   · 跨项目直接发 → E_TARGET_NOT_FOUND
 *   · dsh-team 的状态根不越过项目根
 *
 * 这条边界是用户的明确要求：「插件会话只能在项目内部生效」。
 * 早先为了修 E_TARGET_NOT_FOUND 把注册表放开成全局，结果在 A 项目能看到
 * B 项目全部会话的 id 与标题 —— 越权，且制造「看得到却发不出去」的假目标。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionsProvider, isWithin, nearestProjectRoot } from '../src/registry/dsh-sessions.ts'
import { CompositeRegistry } from '../src/registry/registry.ts'
import { createRouter } from '../src/router/index.ts'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { DEFAULT_CONFIG } from '../src/config/schema.ts'
import { DshTeamAdapter } from '../src/registry/dsh-team-adapter.ts'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT_A = 'D:\\proj-a'
const PROJECT_B = 'D:\\proj-b'
const LOOP = 'D:\\openclaw-data\\agents\\shared\\SOP\\loop'

function rec(id, cwd, live = false) {
  return { header: { id, cwd, title: id, createdAt: 1 }, live, persisted: true }
}

function fakeAgent(id, cwd) {
  return {
    id,
    session: { header: { id, cwd, title: id } },
    steer: () => {},
    followup: () => {},
    inject: () => {},
    send: () => {},
  }
}

function host({ live = {}, persisted = [] } = {}) {
  return {
    get(name) {
      if (name === 'agents') {
        return { list: () => Object.values(live), get: (id) => live[id] }
      }
      if (name === 'sessionQuery') {
        return { listSessions: async () => persisted }
      }
      return undefined
    },
  }
}

// ─────────────────────────────────────────────────────────────
// isWithin：路径归属判定
// ─────────────────────────────────────────────────────────────

test('isWithin：同路径 / 子路径 / 兄弟路径 / 前缀陷阱', () => {
  assert.equal(isWithin(PROJECT_A, PROJECT_A), true, '同一路径')
  assert.equal(isWithin(PROJECT_A, 'D:\\proj-a\\sub'), true, '子路径')
  assert.equal(isWithin(PROJECT_A, 'D:\\proj-a\\sub\\deep'), true, '孙路径')
  assert.equal(isWithin(PROJECT_A, PROJECT_B), false, '兄弟路径')
  assert.equal(isWithin(PROJECT_A, 'D:\\proj-ab'), false, '前缀陷阱：proj-ab 不属于 proj-a')
  assert.equal(isWithin(PROJECT_A, 'C:\\proj-a'), false, '不同盘符')
  assert.equal(isWithin('', PROJECT_A), false, '空父路径')
})

test('isWithin：大小写与分隔符不敏感（Windows）', () => {
  assert.equal(isWithin('D:\\Proj-A', 'd:/proj-a/sub'), true)
  assert.equal(isWithin('D:/proj-a/', 'D:\\proj-a\\sub'), true)
})

test('isWithin：loop 项目与它的父目录是不同项目', () => {
  // openclaw-data 是父，loop 是子 —— 它们各自是独立项目
  assert.equal(isWithin('D:\\openclaw-data', LOOP), true, 'loop 在 openclaw-data 子树内')
  assert.equal(isWithin(LOOP, 'D:\\openclaw-data'), false, '反过来不成立')
})

// ─────────────────────────────────────────────────────────────
// 嵌套项目：取最具体的项目根
// ─────────────────────────────────────────────────────────────

test('nearestProjectRoot：嵌套时取最具体的那个', () => {
  const OUTER = 'D:\\openclaw-data'
  const candidates = [OUTER, LOOP]

  // loop 里的会话 → 归 loop（更具体），不归外层
  assert.equal(nearestProjectRoot(candidates, LOOP), LOOP)
  assert.equal(nearestProjectRoot(candidates, `${LOOP}\\sub`), LOOP)

  // 外层里的会话 → 归外层
  assert.equal(nearestProjectRoot(candidates, OUTER), OUTER)
  assert.equal(nearestProjectRoot(candidates, 'D:\\openclaw-data\\other'), OUTER)

  // 都不包含 → undefined
  assert.equal(nearestProjectRoot(candidates, 'D:\\elsewhere'), undefined)
})

test('nearestProjectRoot：只有外层时，loop 归外层（退化为子树内都算）', () => {
  assert.equal(nearestProjectRoot(['D:\\openclaw-data'], LOOP), 'D:\\openclaw-data')
})

test('嵌套项目：loop 独立后，外层项目看不到 loop 的会话', async () => {
  const OUTER = 'D:\\openclaw-data'
  const ctx = host({
    live: {},
    persisted: [
      rec('outer-1', OUTER),
      rec('outer-2', `${OUTER}\\other`),
      rec('loop-1', LOOP),
      rec('loop-2', `${LOOP}\\sub`),
    ],
  })

  // 外层项目，且知道 loop 是独立项目
  const outerProvider = new DshSessionsProvider({
    ctx,
    projectRoot: OUTER,
    knownProjectRoots: [OUTER, LOOP],
  })
  const outerEntries = await outerProvider.list()
  assert.deepEqual(outerEntries.map((e) => e.id).sort(), ['outer-1', 'outer-2'], '只留外层的')
  assert.equal(outerEntries.some((e) => e.id.startsWith('loop-')), false, 'loop 的不能出现')

  // loop 项目自己看
  const loopProvider = new DshSessionsProvider({
    ctx,
    projectRoot: LOOP,
    knownProjectRoots: [OUTER, LOOP],
  })
  const loopEntries = await loopProvider.list()
  assert.deepEqual(loopEntries.map((e) => e.id).sort(), ['loop-1', 'loop-2'], '只留 loop 的')
})

test('嵌套项目：loop 未独立时，它的会话归外层（兼容旧行为）', async () => {
  const OUTER = 'D:\\openclaw-data'
  const ctx = host({
    live: {},
    persisted: [rec('outer-1', OUTER), rec('loop-1', LOOP)],
  })
  // 只知道外层一个项目根
  const provider = new DshSessionsProvider({ ctx, projectRoot: OUTER, knownProjectRoots: [OUTER] })
  const entries = await provider.list()
  assert.deepEqual(entries.map((e) => e.id).sort(), ['loop-1', 'outer-1'], '子树内都算')
})

// ─────────────────────────────────────────────────────────────
// 注册表：只列本项目
// ─────────────────────────────────────────────────────────────

test('注册表：只列本项目会话，跨项目一律过滤', async () => {
  const ctx = host({
    live: { 'a-live': fakeAgent('a-live', 'D:\\proj-a') },
    persisted: [
      rec('a-live', 'D:\\proj-a', true),
      rec('a-idle', 'D:\\proj-a'),
      rec('a-sub', 'D:\\proj-a\\sub'),
      rec('b-live', 'D:\\proj-b', true),
      rec('b-idle', 'D:\\proj-b'),
      rec('loop-1', LOOP),
    ],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT_A })
  const entries = await provider.list()

  assert.deepEqual(
    entries.map((e) => e.id).sort(),
    ['a-idle', 'a-live', 'a-sub'],
    '只有 proj-a 及其子目录的会话',
  )
  assert.equal(entries.some((e) => e.id.startsWith('b-')), false, '不能出现 proj-b')
  assert.equal(entries.some((e) => e.id === 'loop-1'), false, '不能出现 loop')
})

test('注册表：resolve 也不认跨项目目标', async () => {
  const ctx = host({
    live: {},
    persisted: [rec('a-1', 'D:\\proj-a'), rec('b-1', 'D:\\proj-b')],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT_A })

  assert.equal((await provider.resolve('a-1')).length, 1, '本项目能解析')
  assert.equal((await provider.resolve('b-1')).length, 0, '跨项目解析不到')
})

test('注册表：会话缺 cwd 时排除（宁可少列，不可越界）', async () => {
  const ctx = host({
    live: {},
    persisted: [
      rec('no-cwd', undefined),
      rec('empty-cwd', ''),
      rec('ok', 'D:\\proj-a'),
    ],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT_A })
  const entries = await provider.list()
  assert.deepEqual(entries.map((e) => e.id), ['ok'])
})

test('注册表：活 Agent 也要过项目边界（不能因为"活着"就放行）', async () => {
  const ctx = host({
    live: { 'b-live': fakeAgent('b-live', 'D:\\proj-b') },
    persisted: [],
  })
  const provider = new DshSessionsProvider({ ctx, projectRoot: PROJECT_A })
  const entries = await provider.list()
  assert.equal(entries.length, 0, '别的项目的活 Agent 也不该出现')
})

// ─────────────────────────────────────────────────────────────
// 端到端：跨项目发送必须失败
// ─────────────────────────────────────────────────────────────

test('端到端：跨项目发送 → E_TARGET_NOT_FOUND（不是静默丢弃）', async () => {
  const ctx = host({
    live: {},
    persisted: [rec('a-1', 'D:\\proj-a'), rec('b-1', 'D:\\proj-b')],
  })
  const registry = new CompositeRegistry([new DshSessionsProvider({ ctx, projectRoot: PROJECT_A })])
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport: new InProcessTransport(),
    registry,
  })

  // 本项目：能发
  const ok = await router.send({ from: 'a-1', to: 'a-1', payload: 'hi' })
  assert.equal(ok.messages.length, 1)

  // 跨项目：明确报错
  await assert.rejects(
    () => router.send({ from: 'a-1', to: 'b-1', payload: 'cross' }),
    (error) => error.code === 'E_TARGET_NOT_FOUND',
  )
})

test('端到端：广播只发给本项目的人', async () => {
  const ctx = host({
    live: {},
    persisted: [
      rec('a-1', 'D:\\proj-a'),
      rec('a-2', 'D:\\proj-a'),
      rec('a-3', 'D:\\proj-a'),
      rec('b-1', 'D:\\proj-b'),
      rec('b-2', 'D:\\proj-b'),
    ],
  })
  const registry = new CompositeRegistry([new DshSessionsProvider({ ctx, projectRoot: PROJECT_A })])
  const router = createRouter({
    config: { ...DEFAULT_CONFIG, enabled: true },
    transport: new InProcessTransport(),
    registry,
  })

  const receipt = await router.send({ from: 'a-1', to: '*', payload: 'broadcast' })
  assert.equal(receipt.messages.length, 2, 'a-2 和 a-3（不含自己，也不含 b-*）')
  assert.equal(receipt.messages.every((m) => m.toId.startsWith('a-')), true)
})

// ─────────────────────────────────────────────────────────────
// dsh-team：状态根不越过项目根
// ─────────────────────────────────────────────────────────────

test('dsh-team：只读本项目下的 team 状态，不扫别的 workspace', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'proj-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'proj-b-'))
  try {
    // A 项目有一个团队
    const teamA = join(rootA, '.agent-teams', 'team-a')
    await mkdir(join(teamA, 'inbox'), { recursive: true })
    await writeFile(
      join(teamA, 'team.json'),
      JSON.stringify({ id: 'team-a', captainSessionId: 'ca', members: [{ id: 'ca', name: 'captain', role: 'lead' }] }),
      'utf8',
    )
    // B 项目也有一个团队
    const teamB = join(rootB, '.agent-teams', 'team-b')
    await mkdir(join(teamB, 'inbox'), { recursive: true })
    await writeFile(
      join(teamB, 'team.json'),
      JSON.stringify({ id: 'team-b', captainSessionId: 'cb', members: [{ id: 'cb', name: 'captain-b', role: 'lead' }] }),
      'utf8',
    )

    const adapter = new DshTeamAdapter({ projectRoot: rootA, stateDir: '.agent-teams' })
    const entries = await adapter.list()

    assert.equal(entries.some((e) => e.teamId === 'team-a'), true, 'A 项目的团队要能看到')
    assert.equal(entries.some((e) => e.teamId === 'team-b'), false, 'B 项目的团队不能出现')
  } finally {
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  }
})
