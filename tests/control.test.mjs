/**
 * 测试 6：项目开关的写入口（`src/api/control.ts`）。
 *
 * 这是唯一会写文件的地方，所以必须守死这几条：
 *   · 只翻 `enabled`，**用户手写的其它字段原样保留**（关掉不丢配置）；
 *   · 坏配置**拒绝覆盖**（覆盖等于悄悄丢掉用户内容，还掩盖了错误）；
 *   · 首次创建给一份能直接跑的最小配置；
 *   · 原子写（临时文件 + rename），不留半截 JSON；
 *   · 已处于目标态时不重复写盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectControl, normalizeProjectRoot, readRawProjectConfig } from '../src/api/control.ts'
import { DEFAULT_PROJECT_CONFIG_NAME } from '../src/config/project-config.ts'
import { loadProjectConfig } from '../src/config/project-config.ts'

/** 造一个「读状态 = 真读盘」的最小 control 环境（模拟装配层的 readState/reconfigure）。 */
function makeControl(withReconfigure = true) {
  const reconfigured = []
  const control = createProjectControl({
    readState: async (root) => {
      const loaded = await loadProjectConfig({ projectRoot: root })
      return {
        projectRoot: root,
        projectConfigPath: loaded.projectConfigPath,
        present: loaded.present,
        enabled: loaded.value.enabled,
        reason: loaded.value.enabled ? undefined : '未开启',
      }
    },
    reconfigure: async (root) => {
      reconfigured.push(root)
      const loaded = await loadProjectConfig({ projectRoot: root })
      return {
        projectRoot: root,
        projectConfigPath: loaded.projectConfigPath,
        present: loaded.present,
        enabled: loaded.value.enabled,
      }
    },
  })
  return { control, reconfigured }
}

test('首次开启：创建配置文件，enabled=true + 最小 transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    const { control, reconfigured } = makeControl()
    const state = await control.toggle(dir)
    assert.equal(state.enabled, true)
    assert.equal(reconfigured.length, 1, '切换后必须热装配一次')

    const raw = JSON.parse(await readFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), 'utf8'))
    assert.equal(raw.enabled, true)
    assert.equal(raw.transport.kind, 'sqlite')
    assert.equal(raw.scope, 'project')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('再次切换 = 关闭，但**保留**用户手写的其它字段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    await writeFile(
      join(dir, DEFAULT_PROJECT_CONFIG_NAME),
      JSON.stringify({
        enabled: true,
        transport: { kind: 'file', fileDir: 'D:/custom/dir' },
        router: { allowBroadcast: false, maxPayloadChars: 1234 },
        registry: { sources: ['dsh-sessions'], stateDir: '.my-teams' },
      }),
      'utf8',
    )
    const { control } = makeControl()
    const state = await control.toggle(dir)
    assert.equal(state.enabled, false)

    const raw = JSON.parse(await readFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), 'utf8'))
    assert.equal(raw.enabled, false)
    assert.equal(raw.transport.kind, 'file', 'transport.kind 不能被覆盖')
    assert.equal(raw.transport.fileDir, 'D:/custom/dir')
    assert.equal(raw.router.allowBroadcast, false)
    assert.equal(raw.router.maxPayloadChars, 1234)
    assert.equal(raw.registry.stateDir, '.my-teams')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('关 → 开 往返：配置不丢、可以来回切', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    await writeFile(
      join(dir, DEFAULT_PROJECT_CONFIG_NAME),
      JSON.stringify({ enabled: false, router: { allowBroadcast: false } }),
      'utf8',
    )
    const { control } = makeControl()
    assert.equal((await control.toggle(dir)).enabled, true)
    assert.equal((await control.toggle(dir)).enabled, false)
    assert.equal((await control.toggle(dir)).enabled, true)
    const raw = JSON.parse(await readFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), 'utf8'))
    assert.equal(raw.router.allowBroadcast, false, '来回切三次，自定义字段仍在')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('set：显式设置幂等，已处于目标态时不重复写盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    const { control, reconfigured } = makeControl()
    await control.set(dir, true)
    assert.equal(reconfigured.length, 1)
    // 再设一次 true：状态已一致，不该再次 reconfigure
    const again = await control.set(dir, true)
    assert.equal(again.enabled, true)
    assert.equal(reconfigured.length, 1, '已一致时不应重复热装配')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('坏配置：拒绝覆盖（不悄悄丢掉用户内容）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    await writeFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), '{ "enabled": tru', 'utf8')
    const { control } = makeControl()
    await assert.rejects(
      () => control.toggle(dir),
      (error) => error.code === 'E_TRANSPORT' && /损坏|解析失败/.test(error.message),
    )
    // 原文件必须原样还在
    const text = await readFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), 'utf8')
    assert.equal(text, '{ "enabled": tru')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('原子写：成功后不留 .tmp 残留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    const { control } = makeControl()
    await control.set(dir, true)
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    assert.equal(files.filter((name) => name.endsWith('.tmp')).length, 0)
    assert.ok(files.includes(DEFAULT_PROJECT_CONFIG_NAME))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status：只读，不创建任何文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    const { control } = makeControl()
    const state = await control.status(dir)
    assert.equal(state.enabled, false)
    assert.equal(state.present, false)
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(dir), [], 'status 不该写盘')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('normalizeProjectRoot：空值报错，相对路径归一为绝对', () => {
  assert.throws(() => normalizeProjectRoot(''), /缺少项目根/)
  assert.throws(() => normalizeProjectRoot('   '), /缺少项目根/)
  const absolute = normalizeProjectRoot('D:/openclaw-data')
  assert.match(absolute, /openclaw-data$/)
})

test('readRawProjectConfig：不存在 / 空文件 / 坏 JSON / 非对象 四种情况', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ctl-'))
  try {
    const missing = await readRawProjectConfig(join(dir, 'nope.json'))
    assert.deepEqual([missing.existed, missing.raw, missing.error], [false, {}, undefined])

    const empty = join(dir, 'empty.json')
    await writeFile(empty, '   \n', 'utf8')
    const emptyResult = await readRawProjectConfig(empty)
    assert.deepEqual([emptyResult.existed, emptyResult.raw], [true, {}])

    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{ nope', 'utf8')
    assert.ok((await readRawProjectConfig(broken)).error !== undefined)

    const array = join(dir, 'array.json')
    await writeFile(array, '[1,2]', 'utf8')
    assert.ok((await readRawProjectConfig(array)).error !== undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
