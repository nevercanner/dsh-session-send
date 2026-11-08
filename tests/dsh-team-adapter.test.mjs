/**
 * 测试 4：dsh-team adapter 只用「包装」，不复制它的注册逻辑。
 *
 * 用真实目录形状造一份 dsh-team 状态（team.json + inbox/*.jsonl），断言：
 *   · 注册表能从 team.json 读出 lead / teammate（含 `teamId:name` 写法）；
 *   · 投递走的是**它自己的** inbox JSONL 布局（一行一条 {id, from, to, content, ts}）；
 *   · 找不到目标 / team 不存在时明确失败，不假装成功；
 *   · 版本漂移（没有 mailbox 模块）时降级为 fs-only，消息仍然不丢。
 *
 * 这里刻意**不 import dsh-team 的源码**：adapter 的兼容分支必须能在它缺席时工作，
 * 所以测试也只依赖磁盘契约（这正是 mailbox 的实际契约）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshTeamAdapter } from '../src/registry/dsh-team-adapter.ts'

async function makeTeam(root, options = {}) {
  const stateDir = options.stateDir ?? '.agent-teams'
  const teamId = options.teamId ?? 'team-alpha'
  const teamRoot = join(root, stateDir, teamId)
  await mkdir(join(teamRoot, 'inbox'), { recursive: true })
  await writeFile(
    join(teamRoot, 'team.json'),
    JSON.stringify({
      id: teamId,
      name: 'Alpha Team',
      captainSessionId: 'session-captain',
      halted: false,
      members: [
        { id: 'session-captain', name: 'captain', role: 'lead', status: 'running' },
        { id: 'session-member-1', name: 'researcher', status: 'inactive' },
      ],
    }),
    'utf8',
  )
  return { teamId, teamRoot }
}

async function readInbox(teamRoot, key) {
  try {
    const raw = await readFile(join(teamRoot, 'inbox', `${key}.jsonl`), 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('list：从 team.json 读出 lead 与 teammate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    await makeTeam(root)
    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    const entries = await adapter.list()
    assert.equal(entries.length, 2)
    const captain = entries.find((entry) => entry.name === 'captain')
    assert.equal(captain.role, 'lead')
    assert.equal(captain.teamId, 'team-alpha')
    assert.equal(entries.find((entry) => entry.name === 'researcher').role, 'teammate')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolve：session id / 成员名 / teamId:name 三种写法都命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    await makeTeam(root)
    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    assert.equal((await adapter.resolve('session-member-1')).length, 1)
    assert.equal((await adapter.resolve('researcher')).length, 1)
    assert.equal((await adapter.resolve('team-alpha:researcher')).length, 1)
    assert.equal((await adapter.resolve('nobody')).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deliver：写入 dsh-team 自己的 inbox JSONL 布局（版本漂移时降级 fs-only）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    const { teamRoot } = await makeTeam(root)
    // 不给 packageDir，也不提供 ctx.agentTeams。
    // 机器上装了 dsh-team 时会走 mailbox 分支（queued/durable），没装时走 fs-only（durable）：
    // 两者都必须把消息写进**它的** inbox，这才是这条用例要守的契约。
    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    const [target] = (await adapter.list()).filter((entry) => entry.name === 'researcher')
    const delivery = await adapter.deliver(target, 'alpha', 'hello from the bus')
    assert.equal(delivery.ok, true)
    assert.ok(
      ['durable', 'queued', 'woken'].includes(delivery.mode),
      `unexpected delivery mode ${delivery.mode}: ${delivery.detail}`,
    )

    const inbox = await readInbox(teamRoot, 'researcher')
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].from, 'alpha')
    assert.equal(inbox[0].to, 'researcher')
    assert.equal(inbox[0].content, 'hello from the bus')
    assert.equal(typeof inbox[0].id, 'string')
    assert.equal(typeof inbox[0].ts, 'number')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deliver 给 captain：落到 captain.jsonl（dsh-team 的 captain 键）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    const { teamRoot } = await makeTeam(root)
    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    const captain = (await adapter.list()).find((entry) => entry.role === 'lead')
    const delivery = await adapter.deliver(captain, 'alpha', 'report to captain')
    assert.equal(delivery.ok, true)
    const inbox = await readInbox(teamRoot, 'captain')
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].content, 'report to captain')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deliver：team 不存在时明确失败（不是静默成功）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    await makeTeam(root)
    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    const delivery = await adapter.deliver(
      { id: 'ghost', name: 'ghost', kind: 'agent', source: 'dsh-team', teamId: 'no-such-team' },
      'alpha',
      'x',
    )
    assert.equal(delivery.ok, false)
    assert.equal(delivery.mode, 'failed')
    assert.match(String(delivery.detail), /找不到团队|未安装|无法解析/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('available：team.json 存在即可用（损坏文件不影响整体）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    await makeTeam(root)
    // 再塞一个坏掉的 team 目录
    const broken = join(root, '.agent-teams', 'broken-team')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'team.json'), '{ this is not json', 'utf8')

    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    const entries = await adapter.list()
    assert.equal(entries.length, 2, '坏团队被跳过，好团队照常')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('diagnostics：报告实际模式与包目录，便于排查「只落库没唤醒」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshbus-team-'))
  try {
    await makeTeam(root)
    const adapter = new DshTeamAdapter({ projectRoot: root, stateDir: '.agent-teams' })
    await adapter.list()
    const diagnostics = adapter.diagnostics()
    assert.ok(['service', 'mailbox', 'fs-only'].includes(diagnostics.mode))
    assert.equal(typeof diagnostics.packageDir === 'string' || diagnostics.packageDir === undefined, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
