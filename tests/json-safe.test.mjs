/**
 * 测试 14：工具返回值的**无损 JSON** 合规性（真实事故回归）。
 *
 * 事故：管线维护会话调 `dsh_bus_agents`，宿主报
 *   `tool "dsh_bus_agents" returned invalid output: value is not lossless JSON`
 *
 * 根因：宿主的 `snapshotJsonValue()` 只接受 plain object/array 与
 * string/number/boolean/null，**明确拒绝 undefined**。
 * 而我们的 `AgentEntry` 里 `workspace` / `status` / `teamId` / `role` 都是可选的，
 * 序列化后就是 undefined —— 业务逻辑全对，整次工具调用却失败。
 *
 * 这份用例按宿主的真实规则校验，确保任何工具的返回值都过得了那一关。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toLosslessJson, asToolResult } from '../src/api/json-safe.ts'

/**
 * 复刻宿主的 `walkJsonValue` 判定规则（读 dsh-util-values 源码得出）。
 * 返回 true 表示宿主会接受这个值。
 */
function isLosslessJson(value, seen = new WeakSet()) {
  if (value === undefined) return false
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type === 'bigint' || type === 'function' || type === 'symbol') return false
  if (type !== 'object') return false

  if (seen.has(value)) return false // 循环引用
  seen.add(value)

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    // 数组不能有额外自有属性
    if (Reflect.ownKeys(value).length !== value.length + 1) return false
    const ok = value.every((entry) => isLosslessJson(entry, seen))
    seen.delete(value)
    return ok
  }

  // 必须是 plain object
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  for (const key of Object.keys(value)) {
    if (!isLosslessJson(value[key], seen)) {
      seen.delete(value)
      return false
    }
  }
  seen.delete(value)
  return true
}

// ─────────────────────────────────────────────────────────────
// toLosslessJson：基本类型
// ─────────────────────────────────────────────────────────────

test('基本类型：string / number / boolean / null 原样保留', () => {
  assert.equal(toLosslessJson('abc'), 'abc')
  assert.equal(toLosslessJson(42), 42)
  assert.equal(toLosslessJson(true), true)
  assert.equal(toLosslessJson(null), null)
})

test('undefined → undefined（由调用方省略该字段）', () => {
  assert.equal(toLosslessJson(undefined), undefined)
})

test('NaN / Infinity → null（JSON 不支持）', () => {
  assert.equal(toLosslessJson(NaN), null)
  assert.equal(toLosslessJson(Infinity), null)
  assert.equal(toLosslessJson(-Infinity), null)
})

test('bigint → 字符串（保精度，不丢信息）', () => {
  assert.equal(toLosslessJson(123n), '123')
  assert.equal(toLosslessJson(9007199254740993n), '9007199254740993', '超过 Number 安全整数也不丢精度')
})

test('Date → ISO 字符串；无效日期 → null', () => {
  const d = new Date('2026-11-08T00:00:00.000Z')
  assert.equal(toLosslessJson(d), '2026-11-08T00:00:00.000Z')
  assert.equal(toLosslessJson(new Date('invalid')), null)
})

test('function / symbol → undefined（省略）', () => {
  assert.equal(toLosslessJson(() => {}), undefined)
  assert.equal(toLosslessJson(Symbol('x')), undefined)
})

// ─────────────────────────────────────────────────────────────
// 容器
// ─────────────────────────────────────────────────────────────

test('对象：undefined 字段整体省略，不是写成 null', () => {
  const result = toLosslessJson({ a: 1, b: undefined, c: 'x' })
  assert.deepEqual(result, { a: 1, c: 'x' })
  assert.equal('b' in result, false, 'b 应该完全不存在')
})

test('数组：undefined 项转 null（数组不能跳位）', () => {
  assert.deepEqual(toLosslessJson([1, undefined, 3]), [1, null, 3])
})

test('嵌套对象：深层 undefined 也省略', () => {
  const result = toLosslessJson({
    agent: { id: 'a', workspace: undefined, status: 'live' },
    list: [{ id: 'b', role: undefined }],
  })
  assert.deepEqual(result, {
    agent: { id: 'a', status: 'live' },
    list: [{ id: 'b' }],
  })
})

test('Map → 普通对象；Set → 数组', () => {
  assert.deepEqual(toLosslessJson(new Map([['a', 1], ['b', 2]])), { a: 1, b: 2 })
  assert.deepEqual(toLosslessJson(new Set([1, 2, 3])), [1, 2, 3])
})

test('循环引用：该分支省略，不抛错', () => {
  const a = { name: 'a' }
  a.self = a
  const result = toLosslessJson(a)
  assert.deepEqual(result, { name: 'a' })
})

test('类实例：退化为字符串，不丢整条记录', () => {
  class Foo {
    constructor() {
      this.x = 1
    }
    toString() {
      return 'Foo!'
    }
  }
  assert.equal(toLosslessJson(new Foo()), 'Foo!')
})

// ─────────────────────────────────────────────────────────────
// 真实场景：AgentEntry
// ─────────────────────────────────────────────────────────────

test('AgentEntry：可选字段为 undefined 时仍能过宿主校验', () => {
  // 这就是真实事故里的形状：dsh-sessions 的条目没有 teamId/role
  const agents = [
    { id: 's-1', name: 'alpha', kind: 'session', source: 'dsh-sessions', workspace: 'D:\\p', status: 'live' },
    { id: 's-2', name: 'beta', kind: 'session', source: 'dsh-sessions', workspace: undefined, status: 'inactive' },
  ]
  const result = asToolResult({
    agents,
    sources: [{ source: 'dsh-sessions', available: true, count: 2 }],
    adapter: undefined, // 没有 dsh-team 时就是 undefined
  })

  assert.equal(isLosslessJson(result), true, '必须通过宿主的无损 JSON 校验')
  assert.equal(result.agents.length, 2)
  assert.equal('adapter' in result, false, 'undefined 的 adapter 应被省略')
  assert.equal('workspace' in result.agents[1], false, 'undefined 的 workspace 应被省略')
})

test('完整工具返回：混合 undefined / Date / Map 也能过校验', () => {
  const result = asToolResult({
    agents: [{ id: 'a', teamId: undefined, role: undefined, workspace: undefined }],
    sources: [{ source: 'dsh-team', available: false, count: 0 }],
    adapter: { mode: 'mailbox', resolved: true, packageDir: undefined, error: undefined },
    at: new Date('2026-11-08T00:00:00.000Z'),
    extra: new Map([['k', undefined]]),
  })
  assert.equal(isLosslessJson(result), true)
  assert.equal(result.at, '2026-11-08T00:00:00.000Z')
  assert.deepEqual(result.extra, {})
})

test('asToolResult：非对象输入包成 { value }', () => {
  assert.deepEqual(asToolResult('hello'), { value: 'hello' })
  assert.deepEqual(asToolResult(42), { value: 42 })
  assert.deepEqual(asToolResult(undefined), {}, 'undefined 无法表达，返回空对象')
  assert.deepEqual(asToolResult(null), { value: null }, 'null 是合法 JSON，保留它')
})

test('asToolResult：数组输入包成 { value: [...] }', () => {
  assert.deepEqual(asToolResult([1, 2]), { value: [1, 2] })
})

// ─────────────────────────────────────────────────────────────
// 四个工具的真实返回形状
// ─────────────────────────────────────────────────────────────

test('dsh_bus_send 的 receipt：deliveries 带 undefined 也能过校验', () => {
  const receipt = {
    ok: true,
    messages: [
      {
        id: 'm-1',
        ts: 1,
        kind: 'text',
        fromId: 'a',
        fromName: undefined,
        fromSource: 'unknown',
        toId: 'b',
        toName: undefined,
        replyTo: undefined,
        payload: { text: 'hi', data: undefined },
      },
    ],
    deliveries: [
      { to: 'b', toName: undefined, toSource: 'dsh-sessions', messageId: 'm-1', mode: 'steered', detail: undefined },
    ],
  }
  const result = asToolResult(receipt)
  assert.equal(isLosslessJson(result), true)
  assert.equal(result.deliveries[0].mode, 'steered')
  assert.equal('detail' in result.deliveries[0], false)
})

test('dsh_bus_inbox 的返回：unread 与 messages 都能过校验', () => {
  const result = asToolResult({
    owner: 'a',
    messages: [{ id: 'm-1', payload: { text: 'x' }, replyTo: undefined }],
    unread: [{ target: 'a', count: 0 }],
  })
  assert.equal(isLosslessJson(result), true)
})

test('dsh_bus_reply 的返回：messageId 可能 undefined', () => {
  const result = asToolResult({ to: 'b', messageId: undefined, deliveries: [] })
  assert.equal(isLosslessJson(result), true)
  assert.equal('messageId' in result, false)
})
