/**
 * 模型侧工具：把总线能力做成 4 个工具，注册进宿主 `ctx.tools`。
 *
 * 设计取舍：工具是**普通工具**（不是 PTC 专用），名字以 `dsh_bus_` 前缀避免撞名；
 * 每个工具的 description 里直接写明「未开启会报 E_DISABLED」，模型能自己读懂。
 *
 *   dsh_bus_send    发消息 {to, kind?, text, data?, replyTo?, from?}
 *   dsh_bus_inbox   看自己的来信（未读优先）+ 未读数
 *   dsh_bus_agents  可寻址的 agent/session 列表
 *   dsh_bus_reply   回一条消息（内部就是 kind=response + replyTo）
 *
 * 发送方身份：默认取 `exec.agent.id`（当前调用者的 session id），
 * 也可用 `from` 覆盖（跨来源转发场景）。
 */
import type { BusService } from './service.ts'
import { BusError, type BusKind, type SendRequest } from '../types.ts'
import { asToolResult } from './json-safe.ts'
import { writeName, readNames, readClaims, writeClaim } from '../registry/names.ts'

export interface ToolDeps {
  bus: BusService
  /** `ctx.tools` 服务（由调用方在 ctx.inject(['tools']) 里注入，避免在未 inject 的 ctx 上取 getter）。 */
  tools: { register(definition: any): () => void }
  logger?: { warn?(message: string): void }
}

/** 一个最小的 ToolDefinition 形状（与 cordis_inspect `tools.register` 对齐）。 */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: any): Array<{ type: 'text'; text: string }> }
  execute(args: any, exec: any): Promise<unknown>
}

function text(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

function fail(code: string, message: string): never {
  throw new BusError(code as any, message)
}

export function registerBusTools(deps: ToolDeps): Array<() => void> {
  const { bus, tools } = deps
  const dispose: Array<() => void> = []
  const register = (definition: ToolDefinition): void => {
    try {
      const off = tools.register(definition)
      if (typeof off === 'function') dispose.push(off)
    } catch (error) {
      deps.logger?.warn?.(`[dsh-session-send] 注册工具 ${definition.name} 失败：${String(error)}`)
    }
  }

  register({
    name: 'dsh_bus_send',
    description:
      'Send a message to ANOTHER DSH session/agent and wake it — this is how independent sessions hand work ' +
      'to each other without a human copying prompts around (the openclaw `session send` behaviour). ' +
      '`to` accepts a **session id** (the reliable key), a **registered name** (after that session called ' +
      'dsh_bus_register), a dsh-team member name, or "*" for broadcast. ' +
      'Derived display names like "11-08 15:49 · e9f8dca" are for reading only and are NOT addressable. ' +
      'The target session actually receives the text as a user message and starts working: ' +
      'deliveryMode=steer (default) injects at the next step of a running turn; ' +
      'followup queues it as the next turn; notify only deposits it without waking. ' +
      'If the target is not currently open in this process the message is still stored durably ' +
      'and it will pick it up via dsh_bus_inbox when reopened. ' +
      'A missing or ambiguous target raises an explicit error (never silently dropped). ' +
      'Returns E_DISABLED when this project is not enabled.',
    parameters: {
      to: {
        type: 'string',
        required: true,
        description:
          'Recipient: session id (most reliable) / registered name / dsh-team member name / "*". ' +
          'Timestamp-style display names are not addressable.',
      },
      text: { type: 'string', required: true, description: 'Message body (plain text).' },
      kind: {
        type: 'string',
        description: 'text (default) | request | response | event. A response must set replyTo.',
      },
      deliveryMode: {
        type: 'string',
        description:
          'How the target is woken: steer (default, inject into the running turn at its next step) | ' +
          'followup (run as the next turn) | notify (deposit only, do not wake).',
      },
      data: { type: 'object', description: 'Optional structured payload carried beside the text.' },
      replyTo: { type: 'string', description: 'For kind=response: the message id of the original message.' },
      from: { type: 'string', description: 'Override the sender identity (defaults to the calling session id).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: any) => {
        const deliveries: any[] = Array.isArray(value?.deliveries) ? value.deliveries : []
        const lines = deliveries.map(
          (item) =>
            `→ ${item.toName ?? item.to} (${item.toSource ?? '?'}) id=${item.messageId} mode=${item.mode}` +
            (item.detail ? ` — ${item.detail}` : ''),
        )
        return text([`dsh_bus_send: ${deliveries.length} 条消息已发出`, ...lines].join('\n'))
      },
    },
    async execute(args: any, exec: any) {
      const from = typeof args?.from === 'string' && args.from.trim() !== '' ? args.from.trim() : String(exec?.agent?.id ?? '')
      if (from === '') fail('E_TARGET_NOT_FOUND', '无法确定发送方：工具调用没有 agent，且未提供 from')
      const deliveryMode = normalizeDeliveryMode(args?.deliveryMode)
      const request: SendRequest = {
        from,
        to: String(args?.to ?? ''),
        kind: normalizeKind(args?.kind),
        payload: { text: String(args?.text ?? ''), data: args?.data },
        replyTo: typeof args?.replyTo === 'string' && args.replyTo.trim() !== '' ? args.replyTo.trim() : undefined,
        meta: { deliveryMode, fromName: exec?.agent?.session?.header?.title ?? undefined },
      }
      // receipt 里的 deliveries 也可能带 undefined 的 detail/toName，统一归一
      return asToolResult(await bus.send(request, exec))
    },
  })

  register({
    name: 'dsh_bus_inbox',
    description:
      'Read your dsh-bus mailbox. By default this is your INBOX: only messages addressed TO you ' +
      '(messages you sent are not listed here). Pass direction="outbox" to read what you sent instead. ' +
      'Use it after being woken by a message, or to poll while waiting for a reply. ' +
      'Pass markRead=true to mark the returned inbox messages read.',
    parameters: {
      limit: { type: 'number', description: 'Max messages (default 20).' },
      direction: {
        type: 'string',
        description: 'inbox (default, messages addressed to you) | outbox (messages you sent).',
      },
      unreadOnly: { type: 'boolean', description: 'Only unread messages (inbox only).' },
      markRead: { type: 'boolean', description: 'Mark returned messages read for the caller (inbox only).' },
      since: { type: 'number', description: 'Only messages with ts greater than this (ms epoch).' },
      from: { type: 'string', description: 'Override the caller identity whose mailbox is read.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: any) => {
        const messages: any[] = Array.isArray(value?.messages) ? value.messages : []
        if (messages.length === 0) return text('dsh_bus_inbox: 没有消息')
        const lines = messages.map(
          (message) =>
            `${new Date(message.ts).toISOString()} [${message.kind}] ${message.fromName ?? message.fromId} → ` +
            `${message.toName ?? message.toId}: ${String(message.payload?.text ?? '').slice(0, 400)}` +
            (message.replyTo === undefined ? '' : ` (reply_to=${message.replyTo})`) +
            `  id=${message.id}`,
        )
        return text([`dsh_bus_inbox: ${messages.length} 条`, ...lines].join('\n'))
      },
    },
    async execute(args: any, exec: any) {
      const owner = typeof args?.from === 'string' && args.from.trim() !== '' ? args.from.trim() : String(exec?.agent?.id ?? '')
      if (owner === '') fail('E_TARGET_NOT_FOUND', '无法确定调用者身份')
      const limit = typeof args?.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 20

      // 默认**只读收件箱**（to = 我）。
      // 早先用 `involving`（from 或 to 任一侧是我），导致自己发出的消息也出现在
      // 自己的信箱里 —— 使用者会误以为消息回环了（真实误报）。
      // 想看待发件箱时显式传 direction: 'outbox'。
      const direction = args?.direction === 'outbox' ? 'outbox' : 'inbox'
      const messages = await bus.history(
        direction === 'outbox'
          ? {
              from: owner,
              sinceTs: typeof args?.since === 'number' ? args.since : undefined,
              limit,
            }
          : {
              to: owner,
              unreadOnly: args?.unreadOnly === true,
              sinceTs: typeof args?.since === 'number' ? args.since : undefined,
              limit,
            },
        exec,
      )
      const snapshot = await bus.snapshot(owner, 0, exec)
      if (args?.markRead === true && direction === 'inbox' && messages.length > 0) {
        await bus.markRead(owner, messages.map((message) => message.id), exec)
      }
      return asToolResult({ owner, direction, messages, unread: snapshot.unread })
    },
  })

  register({
    name: 'dsh_bus_agents',
    description:
      'List every addressable identity on the dsh-bus: live DSH sessions and dsh-team members (AgentTeams). ' +
      'Includes per-source availability.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: any) => {
        const agents: any[] = Array.isArray(value?.agents) ? value.agents : []
        const sources: any[] = Array.isArray(value?.sources) ? value.sources : []

        // 项目没开总线：说清为什么，而不是给一个看起来像「没人」的空列表。
        // 真实困惑：用户在未启用的项目里调这个工具，看到 0 个，以为插件坏了。
        if (value?.enabled === false) {
          return text([
            'dsh_bus_agents: 本项目未启用会话总线',
            `  项目：${value?.projectRoot ?? '(未知)'}`,
            `  原因：${value?.disabledReason ?? '未启用'}`,
            '',
            '  怎么开：在左侧栏该会话的「...」菜单里点「会话总线：开启」，',
            '         它会写入配置文件并立即生效。',
            '  开启后还需要每个会话自己报名：dsh_bus_register({ name: "..." })',
          ].join('\n'))
        }

        const head = sources.map((source) => `${source.source}:${source.available ? 'ok' : 'down'}(${source.count})`).join(' ')
        const lines = agents.map((agent) => `${agent.name} (${agent.id}) [${agent.source}/${agent.kind}] ${agent.status ?? ''}`)
        const empty = agents.length === 0
          ? [
              '  （本项目还没有会话报名）',
              '  让某个会话调用：dsh_bus_register({ name: "<名字>" })',
              '  批量报名：dsh_bus_register({ selfName: "<你自己>", entries: { "<session id>": "<名字>" } })',
            ]
          : []
        return text([`dsh_bus_agents: ${agents.length} 个身份  ${head}`, ...lines, ...empty].join('\n'))
      },
    },
    async execute(_args: unknown, exec: any) {
      const owner = String(exec?.agent?.id ?? '')
      const snapshot = await bus.snapshot(owner, 0, exec)
      // 归一成无损 JSON：AgentEntry 的 workspace/status/teamId/role 都可能 undefined，
      // 宿主会以 "value is not lossless JSON" 整单拒绝（真实事故）。
      return asToolResult({
        enabled: snapshot.enabled,
        projectRoot: snapshot.projectRoot,
        disabledReason: snapshot.disabledReason,
        agents: snapshot.agents,
        sources: snapshot.sources,
        adapter: snapshot.adapter,
      })
    },
  })

  register({
    name: 'dsh_bus_reply',
    description:
      'Reply to a dsh-bus message. Equivalent to dsh_bus_send with kind=response and replyTo set; ' +
      'the recipient is taken from the original message, so a reply can never be misrouted.',
    parameters: {
      replyTo: { type: 'string', required: true, description: 'Message id of the original message.' },
      text: { type: 'string', required: true, description: 'Reply body.' },
      data: { type: 'object', description: 'Optional structured payload.' },
      from: { type: 'string', description: 'Override the sender identity.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: any) => text(`dsh_bus_reply: → ${value?.to ?? '?'} id=${value?.messageId ?? '?'}`),
    },
    async execute(args: any, exec: any) {
      const replyTo = String(args?.replyTo ?? '').trim()
      if (replyTo === '') fail('E_REPLY_TARGET_MISSING', 'dsh_bus_reply 需要 replyTo')
      const original = await bus.history({ limit: 1000 }, exec)
      const target = original.find((message) => message.id === replyTo)
      if (target === undefined) fail('E_REPLY_TARGET_MISSING', `replyTo 指向的消息不存在：${replyTo}`)
      const from =
        typeof args?.from === 'string' && args.from.trim() !== '' ? args.from.trim() : String(exec?.agent?.id ?? '')
      if (from === '') fail('E_TARGET_NOT_FOUND', '无法确定发送方身份')
      const receipt = await bus.send(
        {
          from,
          to: target.fromId,
          kind: 'response',
          payload: { text: String(args?.text ?? ''), data: args?.data },
          replyTo,
        },
        exec,
      )
      return asToolResult({
        to: target.fromName ?? target.fromId,
        messageId: receipt.messages[0]?.id,
        deliveries: receipt.deliveries,
      })
    },
  })

  // ── 自注册：会话给自己起名 ──
  // 这是「不写死、可推广」的关键：不需要任何人事先知道 session id。
  // 每个会话在自己那一轮里调一次，名字就记进**本项目**的名册，
  // 之后列表里显示它、`to: "名字"` 也能直接寻址。
  register({
    name: 'dsh_bus_register',
    description:
      'Register readable names on the dsh-bus for THIS PROJECT. ' +
      'Sessions in DSH usually have no title, so a bus list shows only derived labels like "11-08 15:49 · e9f8dca" ' +
      'which are NOT addressable. Registering gives a stable name bound to the session id, ' +
      'so others can `dsh_bus_send({ to: "<name>" })` without knowing the uuid. ' +
      'Stored per-project in .dsh-bus/names.json — no config editing needed. ' +
      'Two forms: `{ name: "管线维护" }` names YOUR OWN session; ' +
      '`{ entries: { "<session id>": "<name>", ... } }` names several at once ' +
      '(useful for setting up a whole project in one call). ' +
      'Pass an empty name to clear a registration.',
    parameters: {
      name: {
        type: 'string',
        description: 'Readable name for the calling session (or for sessionId when given).',
      },
      sessionId: {
        type: 'string',
        description: 'Optional: register on behalf of another session id (defaults to the calling session).',
      },
      entries: {
        type: 'object',
        description:
          'Batch form: a map of { "<session id>": "<name>" }. Every key must belong to this project. ' +
          'An empty-string name clears that entry. ' +
          'IMPORTANT: `entries` does not include the caller unless you list it explicitly — ' +
          'use `selfName` to name yourself in the same call.',
      },
      selfName: {
        type: 'string',
        description:
          'Name for the CALLING session, applied in the same call as `entries`. ' +
          'Without this, a batch registration names the other sessions but leaves you unnamed.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: any) => {
        if (Array.isArray(value?.applied)) {
          const lines = value.applied.map((item: any) =>
            item.cleared === true
              ? `  ${item.sessionId} → (已清除)`
              : `  ${item.name} → ${item.sessionId}${item.self === true ? '  (你自己)' : ''}`,
          )
          const head = `dsh_bus_register: ${value.applied.length} 条（本项目名册共 ${value.total ?? '?'} 条）`
          const failed = Array.isArray(value.rejected) && value.rejected.length > 0
            ? ['被拒绝：', ...value.rejected.map((r: any) => `  ${r.sessionId}: ${r.reason}`)]
            : []
          const warns = Array.isArray(value.warnings) && value.warnings.length > 0
            ? ['⚠️ 注意：', ...value.warnings.map((w: string) => `  ${w}`)]
            : []
          return text([head, ...lines, ...failed, ...warns].join('\n'))
        }
        if (value?.cleared === true) return text(`dsh_bus_register: 已清除 ${value.sessionId} 的名字`)
        if (value?.persisted === false) {
          return text(`dsh_bus_register: ⚠️ 写入后回读不到 ${value.name} → ${value.sessionId}，写盘可能失败`)
        }
        return text(`dsh_bus_register: ${value?.name ?? '?'} → ${value?.sessionId ?? '?'}（本项目名册已更新）`)
      },
    },
    async execute(args: any, exec: any) {
      const runtime = await bus.runtimeFor(exec)
      const registry = await bus.registryFor(exec)

      // ── 批量形式：一次给多条会话起名（整项目初始化用）──
      if (args?.entries !== undefined && args.entries !== null) {
        if (typeof args.entries !== 'object' || Array.isArray(args.entries)) {
          fail('E_TARGET_NOT_FOUND', 'entries 需要是 { "<session id>": "<name>" } 形式的对象')
        }
        const applied: Array<Record<string, unknown>> = []
        const rejected: Array<Record<string, unknown>> = []
        const callerId = String(exec?.agent?.id ?? '')

        // 先给调用者自己起名（如果给了 selfName）。
        // 真实事故：用户照着示例只传了 6 个 lane 的 entries，结果 6 个都写进去了，
        // 调用者自己从头到尾没进名册 —— 批量表单天然不含"我"。
        const selfName = typeof args?.selfName === 'string' ? args.selfName.trim() : undefined
        if (selfName !== undefined && selfName !== '' && callerId !== '') {
          const names = await writeName(runtime.projectRoot, callerId, selfName)
          applied.push({
            sessionId: callerId,
            name: selfName,
            cleared: false,
            self: true,
            total: Object.keys(names).length,
          })
        }

        for (const [rawId, rawName] of Object.entries(args.entries as Record<string, unknown>)) {
          const sessionId = String(rawId ?? '').trim()
          const name = typeof rawName === 'string' ? rawName.trim() : ''
          if (sessionId === '') {
            rejected.push({ sessionId: rawId, reason: '空 session id' })
            continue
          }
          // 项目边界：不允许给别的项目的会话起名。
          // 用 sessionBelongsToProject（含未报名）—— 它们正要被报名，还没进名册。
          const inProject = await bus.sessionBelongsToProject(sessionId, exec)
          if (!inProject) {
            rejected.push({ sessionId, reason: '不属于本项目' })
            continue
          }
          const names = await writeName(runtime.projectRoot, sessionId, name)
          applied.push({
            sessionId,
            name: name === '' ? undefined : name,
            cleared: name === '',
            total: Object.keys(names).length,
          })
        }
        const finalNames = await readNames(runtime.projectRoot)
        // 调用者自己有没有名字？没有就明确警告，别让它以为自己也登记了。
        const callerNamed = callerId !== '' && finalNames[callerId] !== undefined
        const warnings: string[] = []
        if (callerId !== '' && !callerNamed) {
          warnings.push(
            `调用者 ${callerId} 自己还没有名字。entries 不会自动包含你自己 —— ` +
              `补一次 dsh_bus_register({ name: "..." })，或在本次调用里传 selfName: "..."。`,
          )
        }
        return asToolResult({
          applied,
          rejected,
          total: Object.keys(finalNames).length,
          callerId: callerId === '' ? undefined : callerId,
          callerNamed,
          warnings,
          projectRoot: runtime.projectRoot,
        })
      }

      // ── 单条形式 ──
      const target =
        typeof args?.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : String(exec?.agent?.id ?? '')
      if (target === '') fail('E_TARGET_NOT_FOUND', '无法确定要登记的会话 id')
      const requested = typeof args?.name === 'string' ? args.name.trim() : ''

      // 只允许登记本项目内的会话（跨项目写名册是越权）。
      //
      // 注意：不能用 `registry.resolve()` 校验 —— 它现在只认**已报名**的会话，
      // 而这里正要给一个还没报名的会话报名，会形成死循环（永远报不上名）。
      // 所以改用 `listAll()`（含未报名）做项目归属校验。
      const inProject = await bus.sessionBelongsToProject(target, exec)
      if (!inProject) {
        fail('E_TARGET_NOT_FOUND', `会话 ${target} 不属于本项目，不能在这里登记名字`)
      }

      const names = await writeName(runtime.projectRoot, target, requested)
      // 回读校验：写完必须能读到，否则说明写盘失败 —— 不能只看返回值就报告成功。
      const verify = await readNames(runtime.projectRoot)
      const persisted = requested === '' ? verify[target] === undefined : verify[target]?.name === requested
      return asToolResult({
        sessionId: target,
        name: requested === '' ? undefined : requested,
        cleared: requested === '',
        persisted,
        total: Object.keys(verify).length,
        projectRoot: runtime.projectRoot,
      })
    },
  })

  // ── 名册校对：列出「注册名」与「会话自述」对不上的条目 ──
  // 真实场景：批量报名时把 id 和 lane 名字配错了，之后每条消息都发给了错的人。
  // 光看名册看不出来（名字都在），要靠会话自己的身份声明来比对。
  register({
    name: 'dsh_bus_whoami',
    description:
      'Report this session\'s bus identity, and check the whole project roster for mismatches. ' +
      'Use it when messages seem to reach the wrong lane: it shows your registered name, your session id, ' +
      'and any registry entry whose name does not match what that session says it is. ' +
      'Pass `claim` to also record what you assert your lane is (stored beside the name, never overwrites it).',
    parameters: {
      claim: {
        type: 'string',
        description: 'Optional: what YOU say your lane is (e.g. "chapter"). Recorded for mismatch checking.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: any) => {
        const lines = [`dsh_bus_whoami: ${value?.name ?? '(未注册)'}  id=${value?.sessionId ?? '?'}`]
        if (value?.claim !== undefined) lines.push(`  你的声明：${value.claim}`)
        if (Array.isArray(value?.mismatches) && value.mismatches.length > 0) {
          lines.push(`  ⚠️ 名册有 ${value.mismatches.length} 处名字与自述不一致：`)
          for (const m of value.mismatches) {
            lines.push(`    ${m.id}：注册名 ${m.registered} / 自述 ${m.claimed}`)
          }
        } else {
          lines.push('  名册与自述一致（或还没有人声明过）')
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: any, exec: any) {
      const runtime = await bus.runtimeFor(exec)
      const sessionId = String(exec?.agent?.id ?? '')
      if (sessionId === '') fail('E_TARGET_NOT_FOUND', '无法确定调用者身份')

      const names = await readNames(runtime.projectRoot)
      const claims = await readClaims(runtime.projectRoot)
      const claim = typeof args?.claim === 'string' ? args.claim.trim() : undefined
      if (claim !== undefined && claim !== '') {
        await writeClaim(runtime.projectRoot, sessionId, claim)
      }

      const mismatches: Array<Record<string, unknown>> = []
      for (const [id, entry] of Object.entries(names)) {
        const asserted = claims[id]
        if (asserted === undefined) continue
        if (asserted.claim === entry.name) continue
        mismatches.push({ id, registered: entry.name, claimed: asserted.claim })
      }

      return asToolResult({
        sessionId,
        name: names[sessionId]?.name,
        claim: claim ?? claims[sessionId]?.claim,
        mismatches,
        roster: Object.entries(names).map(([id, v]) => ({
          id,
          name: v.name,
          claimed: claims[id]?.claim,
        })),
      })
    },
  })

  return dispose
}

function normalizeKind(value: unknown): BusKind {
  const kinds: BusKind[] = ['text', 'request', 'response', 'event']
  return typeof value === 'string' && (kinds as string[]).includes(value) ? (value as BusKind) : 'text'
}

function normalizeDeliveryMode(value: unknown): 'steer' | 'followup' | 'notify' {
  return value === 'followup' || value === 'notify' ? value : 'steer'
}