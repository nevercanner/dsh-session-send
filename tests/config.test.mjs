/**
 * 测试 2：配置校验 + **项目级**配置读取（`<workspace>/.dsh-bus.json`）。
 *
 * 关键约束：
 *  - enabled 默认放行 true（任何缺失都落到开启，需显式 false 才关）；
 *  - scope 强制 project（不允许全局生效形态）；
 *  - 项目配置文件不存在 → 开启（默认放行）；
 *  - 坏 JSON → 关闭并标记 degraded；
 *  - profile 侧配置是底、项目文件覆盖。
 *
 * 注意：本用例**完全不涉及 openclaw.json** —— 本项目已把它从配置面移除。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, mergeConfig, validateConfig, validateFallback } from '../src/config/schema.ts'
import { loadProjectConfig, disabledReason, DEFAULT_PROJECT_CONFIG_NAME } from '../src/config/project-config.ts'

test('默认配置：enabled=true（默认放行），scope=project，来源只含 DSH 自身', async () => {
  const { value } = await validateConfig({})
  assert.equal(value.enabled, true)
  assert.equal(value.scope, 'project')
  assert.equal(value.transport.kind, 'sqlite')
  assert.deepEqual(value.registry.sources, ['dsh-team', 'dsh-sessions'])
})

test('空/undefined 配置落到开启（默认放行）；显式 true 也开，显式 false 关', async () => {
  assert.equal((await validateConfig(undefined)).value.enabled, true)
  assert.equal((await validateConfig(null)).value.enabled, true)
  assert.equal((await validateConfig({ enabled: false })).value.enabled, false)
  assert.equal((await validateConfig({ enabled: true })).value.enabled, true)
})

test('scope 只接受 project：传其它值被强制回 project 并留 warning', () => {
  const { value, warnings } = validateFallback({ enabled: true, scope: 'global' })
  assert.equal(value.scope, 'project')
  assert.ok(warnings.some((line) => line.includes('scope')))
})

test('非法 transport.kind 回落 sqlite，非法整数回落默认', () => {
  const { value, warnings } = validateFallback({ transport: { kind: 'redis' }, ui: { pollMs: -5 } })
  assert.equal(value.transport.kind, 'sqlite')
  assert.equal(value.ui.pollMs, DEFAULT_CONFIG.ui.pollMs)
  assert.ok(warnings.length >= 2)
})

test('registry.sources 只接受 DSH 来源，openclaw-sessions 被过滤掉', () => {
  const { value, warnings } = validateFallback({ registry: { sources: ['dsh-team', 'openclaw-sessions'] } })
  assert.deepEqual(value.registry.sources, ['dsh-team'])
  assert.ok(warnings.some((line) => line.includes('registry.sources')))
})

test('mergeConfig：对象深合并，标量覆盖', () => {
  const merged = mergeConfig(
    { enabled: false, ui: { entry: true, pollMs: 4000 } },
    { enabled: true, ui: { pollMs: 9000 } },
  )
  assert.equal(merged.enabled, true)
  assert.equal(merged.ui.pollMs, 9000)
  assert.equal(merged.ui.entry, true)
})

test('loadProjectConfig：项目文件不存在 → 关闭（默认状态，不是错误）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-proj-'))
  try {
    const loaded = await loadProjectConfig({ projectRoot: dir })
    assert.equal(loaded.value.enabled, true, '无文件默认放行')
    assert.equal(loaded.present, false)
    assert.equal(loaded.degraded, false)
    assert.equal(loaded.projectConfigPath, join(dir, DEFAULT_PROJECT_CONFIG_NAME))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectConfig：坏 JSON → 关闭 + degraded（即使写了 enabled=true）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-proj-'))
  try {
    await writeFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), '{ "enabled": true', 'utf8')
    const loaded = await loadProjectConfig({ projectRoot: dir })
    assert.equal(loaded.value.enabled, false, '坏 JSON 绝不能开出总线')
    assert.equal(loaded.present, true)
    assert.equal(loaded.degraded, true)
    assert.ok(loaded.warnings.some((line) => line.includes('解析失败')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectConfig：存在且 enabled=true → 生效，并与 profile 侧配置合并', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-proj-'))
  try {
    await writeFile(
      join(dir, DEFAULT_PROJECT_CONFIG_NAME),
      JSON.stringify({
        enabled: true,
        transport: { kind: 'file' },
        router: { allowBroadcast: false },
      }),
      'utf8',
    )
    const loaded = await loadProjectConfig({ projectRoot: dir, baseConfig: { ui: { entry: false, pollMs: 4000 } } })
    assert.equal(loaded.value.enabled, true)
    assert.equal(loaded.present, true)
    assert.equal(loaded.degraded, false)
    assert.equal(loaded.value.transport.kind, 'file')
    assert.equal(loaded.value.router.allowBroadcast, false)
    // profile 侧的 ui.entry=false 应被保留（项目文件没写 ui 块）
    assert.equal(loaded.value.ui.entry, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectConfig：存在但 enabled=false → 关闭，且能给出一句话原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-proj-'))
  try {
    await writeFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), JSON.stringify({ enabled: false }), 'utf8')
    const loaded = await loadProjectConfig({ projectRoot: dir, baseConfig: { enabled: true } })
    assert.equal(loaded.value.enabled, false)
    assert.match(disabledReason(loaded), /enabled:false/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('空文件视为 {} —— 默认放行（开启）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-proj-'))
  try {
    await writeFile(join(dir, DEFAULT_PROJECT_CONFIG_NAME), '   \n', 'utf8')
    const loaded = await loadProjectConfig({ projectRoot: dir })
    assert.equal(loaded.value.enabled, true)
    assert.equal(loaded.degraded, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('自定义配置文件名生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-proj-'))
  try {
    await writeFile(join(dir, 'bus.custom.json'), JSON.stringify({ enabled: true }), 'utf8')
    const loaded = await loadProjectConfig({ projectRoot: dir, configName: 'bus.custom.json' })
    assert.equal(loaded.value.enabled, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
