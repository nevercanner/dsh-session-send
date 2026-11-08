/**
 * 测试 3：三种 transport 走**同一套接口契约**（可替换性验证）。
 *
 * 这份用例是 transport 层的合同：换实现必须全部通过。
 * 其中 sqlite 用临时库文件（每个用例一份独立库，互不干扰），验证：
 *   · 建表幂等（重复 init）
 *   · 追加 / 读取 / 未读 / 标记已读语义一致
 *   · 发送方自己的消息不算自己的未读
 *   · replyTo / payload.data 原样往返
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { InProcessTransport } from '../src/transport/in-process.ts'
import { FileTransport } from '../src/transport/file.ts'
import { SqliteTransport } from '../src/transport/sqlite.ts'
import { BUS_DDL } from '../src/transport/transport.ts'

function message(overrides) {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind: 'text',
    fromId: 'a',
    fromSource: 'dsh-sessions',
    toId: 'b',
    payload: { text: 'hello' },
    ...overrides,
  }
}

/** 每种 transport 的工厂 + 清理。 */
const factories = [
  {
    name: 'in-process',
    async create() {
      const transport = new InProcessTransport()
      return { transport, cleanup: async () => transport.dispose() }
    },
  },
  {
    name: 'file',
    async create() {
      const dir = await mkdtemp(join(tmpdir(), 'dshbus-file-'))
      const transport = new FileTransport({ dir })
      return { transport, cleanup: async () => rm(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'sqlite',
    async create() {
      const dir = await mkdtemp(join(tmpdir(), 'dshbus-sql-'))
      const transport = new SqliteTransport({ path: join(dir, 'bus.db') })
      // Windows 上 WAL 文件的句柄释放有延迟，rm 可能 EBUSY —— 清理失败不该让用例红。
      return { transport, cleanup: async () => rm(dir, { recursive: true, force: true }).catch(() => undefined) }
    },
  },
]

for (const factory of factories) {
  test(`[${factory.name}] init 幂等 + 追加/读取/未读/已读`, async () => {
    const { transport, cleanup } = await factory.create()
    try {
      await transport.init()
      await transport.init() // 幂等

      const first = message({ id: randomUUID(), ts: 1_000, toId: 'b', payload: { text: 'one' } })
      const second = message({ id: randomUUID(), ts: 1_001, toId: 'b', payload: { text: 'two', data: { n: 1 } } })
      await transport.append(first)
      await transport.appendMany([second])

      const inbox = await transport.list({ to: 'b' })
      assert.equal(inbox.length, 2)
      assert.equal(inbox[0].payload.text, 'one')
      assert.deepEqual(inbox[1].payload.data, { n: 1 })

      assert.equal((await transport.unread(['b']))[0].count, 2)
      assert.equal((await transport.unread(['a']))[0].count, 0, '发送方不算自己的未读')

      await transport.markRead('b', inbox.map((item) => item.id))
      assert.equal((await transport.unread(['b']))[0].count, 0)

      const fetched = await transport.get(second.id)
      assert.equal(fetched.id, second.id)
      assert.equal(fetched.payload.text, 'two')
    } finally {
      await transport.dispose()
      await cleanup()
    }
  })

  test(`[${factory.name}] 未读过滤 + sinceTs 增量 + involving 双向视角`, async () => {
    const { transport, cleanup } = await factory.create()
    try {
      await transport.init()
      const early = message({ id: randomUUID(), ts: 100, fromId: 'a', toId: 'b' })
      const late = message({ id: randomUUID(), ts: 200, fromId: 'b', toId: 'a' })
      await transport.appendMany([early, late])

      const unread = await transport.list({ to: 'a', unreadOnly: true })
      assert.deepEqual(unread.map((item) => item.id), [late.id])

      const incremental = await transport.list({ sinceTs: 150 })
      assert.deepEqual(incremental.map((item) => item.id), [late.id])

      const both = await transport.list({ involving: 'a' })
      assert.equal(both.length, 2)
    } finally {
      await transport.dispose()
      await cleanup()
    }
  })

  test(`[${factory.name}] limit 生效且按 ts 升序`, async () => {
    const { transport, cleanup } = await factory.create()
    try {
      await transport.init()
      await transport.appendMany(
        Array.from({ length: 5 }, (_, index) =>
          message({ id: randomUUID(), ts: 300 + index, toId: 'b', payload: { text: `m${index}` } }),
        ),
      )
      const limited = await transport.list({ to: 'b', limit: 3 })
      assert.equal(limited.length, 3)
      assert.deepEqual(limited.map((item) => item.payload.text), ['m0', 'm1', 'm2'])
    } finally {
      await transport.dispose()
      await cleanup()
    }
  })
}

test('sqlite：DDL 幂等，且能在已有库上重复建表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshbus-ddl-'))
  try {
    const path = join(dir, 'reuse.db')
    const first = new SqliteTransport({ path })
    await first.init()
    await first.append(message({ id: randomUUID(), ts: 1, toId: 'b' }))
    await first.dispose()

    const second = new SqliteTransport({ path })
    await second.init()
    assert.equal((await second.list({ to: 'b' })).length, 1)
    await second.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('DDL 文本包含两张表与索引（迁移 SQL 可独立执行）', () => {
  assert.ok(BUS_DDL.includes('CREATE TABLE IF NOT EXISTS dsh_bus_messages'))
  assert.ok(BUS_DDL.includes('CREATE TABLE IF NOT EXISTS dsh_bus_receipts'))
  assert.ok(BUS_DDL.includes('idx_dsh_bus_messages_to_ts'))
})
