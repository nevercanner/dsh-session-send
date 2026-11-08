/**
 * 测试 11：dsh-team 包解析（真实事故回归）。
 *
 * 事故：插件被 junction 链接进 profile，`import.meta.url` 解析到的是链接的**目标**
 * （`D:\openclaw-data\openclaw-dsh-bus`），从那里向上找不到 profile 的 node_modules，
 * 于是 `createRequire` 永远 MODULE_NOT_FOUND —— adapter 退化为 fs-only。
 *
 * 而本机只有 `DSH_PROFILE` + `DSH_HOME`，**没有** `DSH_PROFILE_DIR`，
 * 原实现只认后者，所以必然失败。
 *
 * 守死的行为：即使 createRequire 失败、DSH_PROFILE_DIR 缺席，
 * 也能通过 DSH_HOME + DSH_PROFILE 找到包。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPackageDir } from '../src/registry/dsh-team-adapter.ts'

const PKG = '@nanmicoder/dsh-agent-teams'

/** 在 root 下造一个假的 profile，装上目标包。 */
async function makeProfile(home, profileName, packageName = PKG) {
  const pkgDir = join(home, 'profiles', profileName, 'node_modules', ...packageName.split('/'))
  await mkdir(join(pkgDir, 'lib'), { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, main: 'lib/index.js' }), 'utf8')
  await writeFile(join(pkgDir, 'lib', 'index.js'), 'export const ok = true', 'utf8')
  return pkgDir
}

/** 临时设置环境变量并在结束后还原。 */
async function withEnv(overrides, fn) {
  const saved = {}
  for (const key of Object.keys(overrides)) saved[key] = process.env[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('DSH_HOME + DSH_PROFILE：即使 DSH_PROFILE_DIR 缺席也能解析（真实事故现场）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  try {
    const pkgDir = await makeProfile(home, 'desktop')
    const found = await withEnv(
      { DSH_HOME: home, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: undefined, OPENCLAW_DSH_BUS_DSH_TEAM_DIR: undefined },
      async () => findPackageDir(PKG),
    )
    assert.equal(found, pkgDir)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('DSH_PROFILE 缺席时：扫描 profiles/* 仍能找到', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  try {
    const pkgDir = await makeProfile(home, 'some-other-profile')
    const found = await withEnv(
      { DSH_HOME: home, DSH_PROFILE: undefined, DSH_PROFILE_DIR: undefined, OPENCLAW_DSH_BUS_DSH_TEAM_DIR: undefined },
      async () => findPackageDir(PKG),
    )
    assert.equal(found, pkgDir, '不知道 profile 名时应该扫 profiles 目录')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('DSH_PROFILE_DIR 优先于 DSH_HOME（显式指定更可信）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  const other = await mkdtemp(join(tmpdir(), 'dshbus-other-'))
  try {
    await makeProfile(home, 'desktop')
    // 在 other 下造一个"独立 profile 目录"
    const explicit = join(other, 'node_modules', ...PKG.split('/'))
    await mkdir(explicit, { recursive: true })
    await writeFile(join(explicit, 'package.json'), JSON.stringify({ name: PKG }), 'utf8')

    const found = await withEnv(
      {
        DSH_HOME: home,
        DSH_PROFILE: 'desktop',
        DSH_PROFILE_DIR: other,
        OPENCLAW_DSH_BUS_DSH_TEAM_DIR: undefined,
      },
      async () => findPackageDir(PKG),
    )
    assert.equal(found, explicit, 'DSH_PROFILE_DIR 应该先命中')
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('显式环境变量最高优先', async () => {
  const explicit = await mkdtemp(join(tmpdir(), 'dshbus-explicit-'))
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  try {
    await writeFile(join(explicit, 'package.json'), JSON.stringify({ name: PKG }), 'utf8')
    await makeProfile(home, 'desktop')
    const found = await withEnv(
      { DSH_HOME: home, DSH_PROFILE: 'desktop', OPENCLAW_DSH_BUS_DSH_TEAM_DIR: explicit },
      async () => findPackageDir(PKG),
    )
    assert.equal(found, explicit)
  } finally {
    await rm(explicit, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('完全找不到：返回 undefined，不抛', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'dshbus-empty-'))
  try {
    const found = await withEnv(
      {
        DSH_HOME: empty,
        DSH_PROFILE: 'nope',
        DSH_PROFILE_DIR: undefined,
        OPENCLAW_DSH_BUS_DSH_TEAM_DIR: undefined,
      },
      async () => findPackageDir('@nonexistent/package-xyz'),
    )
    assert.equal(found, undefined)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('目录存在但没有 package.json：不算命中（避免误认半截目录）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshbus-home-'))
  try {
    const bogus = join(home, 'profiles', 'desktop', 'node_modules', ...PKG.split('/'))
    await mkdir(bogus, { recursive: true }) // 只有目录，没有 package.json
    const found = await withEnv(
      { DSH_HOME: home, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: undefined, OPENCLAW_DSH_BUS_DSH_TEAM_DIR: undefined },
      async () => findPackageDir(PKG),
    )
    assert.equal(found, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('本机真实环境：能解析到 dsh-agent-teams（存在则验证，缺席则跳过）', async () => {
  // 这条是「真机」检查：如果这台机器装了它，就必须能找到。
  const found = findPackageDir(PKG)
  const home = process.env['DSH_HOME']
  const profile = process.env['DSH_PROFILE']
  if (typeof home === 'string' && typeof profile === 'string') {
    const expected = join(home, 'profiles', profile, 'node_modules', ...PKG.split('/'))
    if (existsSync(join(expected, 'package.json'))) {
      assert.equal(found, expected, '本机装了这个包，就必须解析到它')
      return
    }
  }
  // 没装：允许 undefined（这是合法状态，adapter 会退化为 fs-only）
  assert.ok(found === undefined || typeof found === 'string')
})
