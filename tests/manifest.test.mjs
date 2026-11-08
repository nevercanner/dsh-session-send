/**
 * 测试 21：**包清单必须满足宿主加载客户端的要求**（真实事故回归）。
 *
 * 事故：侧栏 Session 行的「...」菜单里没有「会话总线：开启」这一项。
 * 查下来不是 slot 名字错、也不是注册逻辑错 —— 是 package.json 缺 `exports["./client"]`。
 *
 * 宿主的解析（dsh-client-modules）是硬的：
 *   · `parseDshClient` 要求 `dsh.client.platform` 是字符串
 *   · `clientExportOf` 要求 `exports["./client"]` 存在，且是字符串
 *     （或带 default 字符串的对象）
 * 缺了就直接抛错，客户端那一半永远不加载 —— 界面上少一个菜单项，
 * 而且宿主只报「无 client 声明」，看不出是清单的问题。
 *
 * 这个用例把清单约束钉死，避免以后改 package.json 时又把它弄丢。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 复刻宿主的 parseDshClient 校验，返回违规项列表。 */
function validateDshClient(manifest) {
  const problems = []
  const decl = manifest.dsh?.client
  if (decl === undefined) return problems // 没有客户端也可以，跳过
  if (typeof decl !== 'object' || decl === null) {
    problems.push('dsh.client 必须是对象')
    return problems
  }
  if (typeof decl.platform !== 'string') problems.push('dsh.client.platform 必须是字符串')
  if (decl.inject !== undefined && !Array.isArray(decl.inject)) problems.push('dsh.client.inject 必须是数组')
  if (decl.external !== undefined && !Array.isArray(decl.external)) problems.push('dsh.client.external 必须是数组')
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    problems.push('dsh.client.immediately 必须是布尔')
  }
  return problems
}

/** 复刻宿主的 clientExportOf，返回 { entry } 或 { error }。 */
function clientExportOf(manifest) {
  const ex = manifest.exports
  if (ex === undefined) return { error: 'package.json 没有 exports 字段' }
  const client = ex['./client']
  if (client === undefined) return { error: 'exports 里没有 "./client"' }
  if (typeof client === 'string') return { entry: client }
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') {
    return { entry: client.default }
  }
  return { error: 'exports["./client"] 必须是字符串，或带字符串 default 的对象' }
}

// ─────────────────────────────────────────────────────────────
// 声明合法性
// ─────────────────────────────────────────────────────────────

test('dsh.client 声明符合宿主校验（platform 必填且为字符串）', () => {
  const problems = validateDshClient(pkg)
  assert.deepEqual(problems, [], `宿主会拒绝这份声明：${problems.join('；')}`)
})

test('dsh.bundle 已声明（插件能被安装的前提）', () => {
  assert.equal(typeof pkg.dsh?.bundle?.patch, 'string', 'dsh.bundle.patch 必须是字符串')
  assert.equal(existsSync(join(ROOT, pkg.dsh.bundle.patch)), true, 'patch 文件必须真实存在')
})

// ─────────────────────────────────────────────────────────────
// exports["./client"] —— 这次事故的根因
// ─────────────────────────────────────────────────────────────

test('exports["./client"] 存在（缺了客户端永远加载不了）', () => {
  const result = clientExportOf(pkg)
  assert.equal(result.error, undefined, `宿主解析失败：${result.error}`)
  assert.equal(typeof result.entry, 'string')
})

test('exports["./client"] 指向一个真实文件', () => {
  const { entry } = clientExportOf(pkg)
  const abs = resolve(ROOT, entry)
  assert.equal(existsSync(abs), true, `声明的入口不存在：${abs}`)
  // 入口必须是实际产物，不能指向源码
  assert.match(entry, /^\.\/lib\//, '客户端入口应指向构建产物 lib/')
})

test('exports["."] 存在且指向 main 同一文件', () => {
  assert.equal(typeof pkg.exports?.['.'], 'string', 'exports["."] 必须存在（裸包名导入要用）')
  assert.equal(pkg.exports['.'], `./${pkg.main}`.replace('././', './'), '应与 main 一致')
})

test('exports["./package.json"] 存在（工具链读清单要用）', () => {
  assert.equal(pkg.exports?.['./package.json'], './package.json')
})

// ─────────────────────────────────────────────────────────────
// dsh.client.inject 与实际依赖一致
// ─────────────────────────────────────────────────────────────

test('inject 里列的是客户端名册里真实存在的包', () => {
  const inject = pkg.dsh?.client?.inject ?? []
  // 这两个包提供 client 半 inject 的 slots / layout 服务
  for (const name of inject) {
    assert.equal(typeof name, 'string')
    assert.ok(name.length > 0)
  }
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), 'slots 服务来自 sidebar 包')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-layout'), 'layout 服务来自 layout 包')
})

test('portability：package.json 里没有写死本机路径', () => {
  const raw = readFileSync(join(ROOT, 'package.json'), 'utf8')
  assert.equal(raw.includes('D:\\'), false, '不能写死 D: 盘路径')
  assert.equal(raw.includes('C:\\Users'), false, '不能写死用户目录')
  assert.equal(raw.includes('HUAWEI'), false, '不能写死本机用户名')
})