/**
 * 测试 17：**消息闭环**（真实事故回归）。
 *
 * 事故：发送方给 6 个会话各发一条，返回全部 `steered`。
 * 但只有 1 个会话把回答发了回来，另外 4 个**在自己那一轮里回答了**却没调
 * `dsh_bus_send` —— 发送方看到的是「6 条只回来 1 条」，像是投递失败。
 *
 * 两个根因：
 *   ① 消息正文里没有任何「怎么回复」的说明。接收方处理完就把答案写在自己
 *      的对话里，那对发送方是不可见的。
 *   ② 名册里的名字是「别人给起的」，会话自己说的身份没有记录，
 *      所以批量报名配错 id 时无从发现（每条消息都发给了错的人）。
 *
 * 修法：
 *   ① formatContent 固定附一段回复指引（用哪个工具、to 填什么、
 *      「只在自己对话里说等于没回」）
 *   ② 新增 claims.json 记录会话自述，dsh_bus_whoami 比对两者并列出错位
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatContent } from '../src/router/router.ts'
import { readClaims, writeClaim, claimsPathFor, CLAIMS_FILE } from '../src/registry/names.ts'

function message(overrides = {}) {
  return {
    id: 'msg-abc-123',
    ts: 1794130110844,
    kind: 'text',
    fromId: 'session-sender-0001',
    fromName: '管线维护',
    fromSource: 'dsh-sessions',
    toId: 'session-target-0002',
    payload: { text: '第三章就绪，请复核。' },
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────
// ① 回复指引
// ─────────────────────────────────────────────────────────────

test('消息正文必须告诉接收方怎么回复（这是「只回 1 条」的根因）', () => {
  const content = formatContent(message())

  assert.match(content, /dsh_bus_reply/, '要提到 dsh_bus_reply')
  assert.match(content, /replyTo:\s*"msg-abc-123"/, '要给出具体的 replyTo 值')
  assert.match(content, /dsh_bus_send/, '也要给出直接 send 的写法')
  assert.match(content, /管线维护/, '按名字回复时要知道发给谁')
})

test('抬头用显示名，不把 uuid 挤在最显眼的位置', () => {
  const content = formatContent(message())
  const firstLine = content.split('\n')[0]

  assert.match(firstLine, /来自 管线维护/, '第一行就要看到是谁发来的')
  assert.equal(firstLine.includes('msg-abc-123'), false, 'uuid 不该出现在抬头')
  assert.equal(firstLine.includes('session-sender-0001'), false, 'id 也不该出现')

  // 技术标识应该在末尾（工具参数需要），而不是抬头
  const footerIndex = content.indexOf('message_id=msg-abc-123')
  assert.ok(footerIndex > content.indexOf('第三章就绪'), 'message_id 应在正文之后')
})

test('回复类消息在抬头标出「回复」', () => {
  const content = formatContent(message({ replyTo: 'msg-original-999' }))
  assert.match(content.split('\n')[0], /回复/, '抬头应能看出这是一条回复')
  assert.match(content, /reply_to=msg-original-999/, '技术标识在末尾仍保留')
})

test('回复指引明确说「只在自己对话里回答不算回复」', () => {
  const content = formatContent(message())
  assert.match(content, /只在你自己这一轮里回答不算回复/)
  assert.match(content, /发送方看不到/)
})

test('回复指引说「不需要回复就忽略」，不强迫回复', () => {
  const content = formatContent(message())
  assert.match(content, /不需要回复就忽略/)
})

test('原文与元数据仍然完整保留（指引只是追加，不替换）', () => {
  const content = formatContent(message())
  assert.match(content, /来自 管线维护/, '抬头有发送者名字')
  assert.match(content, /第三章就绪，请复核。/, '原文完整')
  assert.match(content, /message_id=msg-abc-123/, '技术标识保留在末尾')
})

test('有 replyTo 时头部带 reply_to', () => {
  const content = formatContent(message({ replyTo: 'msg-original-999' }))
  assert.match(content, /reply_to=msg-original-999/)
})

test('有 data 时保留 <data> 块，且指引在它之后', () => {
  const content = formatContent(message({ payload: { text: '正文', data: { chapter: 3 } } }))
  assert.match(content, /<data>\{"chapter":3\}<\/data>/)
  const dataIndex = content.indexOf('<data>')
  const replyIndex = content.indexOf('dsh_bus_reply')
  assert.ok(replyIndex > dataIndex, '回复指引应在 data 之后')
})

test('没有 fromName 时用 fromId 作为回复目标', () => {
  const content = formatContent(message({ fromName: undefined }))
  assert.match(content, /to:\s*"session-sender-0001"/, '应该回落到 id')
})

// ─────────────────────────────────────────────────────────────
// ② 身份声明（claims）—— 发现名册错位
// ─────────────────────────────────────────────────────────────

test('claims：文件不存在时返回空对象', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-'))
  try {
    assert.deepEqual(await readClaims(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('claims：写入后能读回，存在项目内 .dsh-bus/claims.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-'))
  try {
    await writeClaim(dir, 'session-a', 'chapter')
    const claims = await readClaims(dir)
    assert.equal(claims['session-a'].claim, 'chapter')
    assert.equal(typeof claims['session-a'].at, 'number')
    assert.equal(claimsPathFor(dir), join(dir, '.dsh-bus', CLAIMS_FILE))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('claims：与 names 分开存（名字是别人给的，声明是自己说的）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-'))
  try {
    const { writeName, readNames } = await import('../src/registry/names.ts')
    await writeName(dir, 'session-a', 'gate')       // 名册说它是 gate
    await writeClaim(dir, 'session-a', 'shortdrama') // 它自己说是 shortdrama

    const names = await readNames(dir)
    const claims = await readClaims(dir)
    assert.equal(names['session-a'].name, 'gate')
    assert.equal(claims['session-a'].claim, 'shortdrama')
    assert.notEqual(names['session-a'].name, claims['session-a'].claim, '两者不一致正是要能发现的错位')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('claims：空字符串清除声明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-'))
  try {
    await writeClaim(dir, 'session-a', 'chapter')
    await writeClaim(dir, 'session-a', '  ')
    assert.deepEqual(await readClaims(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('claims：损坏文件按空处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-'))
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(claimsPathFor(dir), '{ broken', 'utf8')
    assert.deepEqual(await readClaims(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('错位检测：名册名与自述不一致时能被识别', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-'))
  try {
    const { writeName, readNames } = await import('../src/registry/names.ts')
    // 模拟真实事故：批量报名把 gate 的 id 配给了 shortdrama 会话
    await writeName(dir, 'session-gate-slot', 'gate')
    await writeClaim(dir, 'session-gate-slot', 'shortdrama')
    await writeName(dir, 'session-ok', 'wechat')
    await writeClaim(dir, 'session-ok', 'wechat')

    const names = await readNames(dir)
    const claims = await readClaims(dir)
    const mismatches = Object.entries(names)
      .filter(([id, v]) => claims[id] !== undefined && claims[id].claim !== v.name)
      .map(([id, v]) => ({ id, registered: v.name, claimed: claims[id].claim }))

    assert.equal(mismatches.length, 1)
    assert.equal(mismatches[0].id, 'session-gate-slot')
    assert.equal(mismatches[0].registered, 'gate')
    assert.equal(mismatches[0].claimed, 'shortdrama')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
