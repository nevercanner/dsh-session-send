/**
 * router 层：解析目标 → 落库 → 投递（唤醒）。含广播与 replyTo 关联。
 *
 * 硬约束：
 *  - 只依赖 ../types.ts、transport 接口、registry 接口；**不读任何配置文件**（配置由构造注入）；
 *  - **不 import ui**；
 *  - 目标不存在必须抛 BusError('E_TARGET_NOT_FOUND')，绝不静默丢弃。
 *
 * 语义参考 OpenClaw 的 `session send`（**做法**，不是它的配置或数据面）：
 *   openclaw:  { sessionKey | agentId | label, message, mode, timeoutSeconds, watch }
 *   本插件:    { from, to, kind, payload, replyTo }
 *   映射说明：
 *     · `sessionKey` / `agentId` / `label` → 我们的 `to`（一个字段接受三者，由 registry 解析，
 *       歧义时报 E_AMBIGUOUS_TARGET 而不是猜）；
 *     · `message`（纯文本）→ `payload.text`；`payload.data` 承载结构化附加数据；
 *     · `mode`（notify/steer/followup/resume）→ 我们固定用「持久 inbox + 尽力唤醒」，
 *       唤醒失败回落为 durable。比 openclaw 的 notify 更耐久（它自己注明 notify 是
 *       bounded process memory、非耐久），这是我们明确改进的一点；
 *     · `timeoutSeconds` / `watch` → 本层不阻塞等待；响应通过 kind='response' + replyTo
 *       回到来信箱，由调用方（模型或 UI）自己决定是否等待，避免把路由层做成同步 RPC。
 */
import { randomUUID } from 'node:crypto'
import {
  BusError,
  type AgentEntry,
  type BusConfig,
  type BusKind,
  type BusMessage,
  type BusPayload,
  type DeliveryResult,
  type SendReceipt,
  type SendRequest,
} from '../types.ts'
import type { Registry } from '../registry/registry.ts'
import type { Transport } from '../transport/transport.ts'
import type { DshTeamAdapter } from '../registry/dsh-team-adapter.ts'
import type { DeliveryMode, SessionPusher } from '../transport/session-push.ts'

const VALID_KINDS: readonly BusKind[] = ['text', 'request', 'response', 'event']

export interface RouterOptions {
  config: BusConfig
  transport: Transport
  registry: Registry
  /** dsh-team adapter（可选；缺席时 dsh-team 目标只落库不唤醒）。 */
  dshTeam?: DshTeamAdapter
  /**
   * 跨会话投递器（可选但**关键**）：负责把消息推进目标的活会话。
   * 缺席时所有目标都退化为「只落库」，等于回到人工转发的旧状态。
   */
  sessions?: SessionPusher
  logger?: { info?(message: string): void; warn?(message: string): void }
  /** 测试注入时钟。 */
  now?: () => number
  /** 测试注入 id 生成。 */
  newId?: () => string
}

export interface Router {
  send(request: SendRequest): Promise<SendReceipt>
  /** 读消息流。 */
  history(query?: {
    involving?: string
    to?: string
    from?: string
    unreadOnly?: boolean
    sinceTs?: number
    limit?: number
  }): Promise<BusMessage[]>
  markRead(target: string, ids: string[]): Promise<number>
  /** 一次拿齐侧栏需要的：可寻址列表 + 未读 + 最近消息。 */
  snapshot(owner: string, limit?: number): Promise<BusSnapshot>
}

export interface BusSnapshot {
  enabled: boolean
  owner: string
  agents: AgentEntry[]
  unread: Array<{ target: string; count: number }>
  messages: BusMessage[]
  /** 每个来源是否可用（UI 上标灰用）。 */
  sources: Array<{ source: string; available: boolean; count: number }>
  /** dsh-team adapter 的实际模式，便于排查「为什么消息只落库没唤醒」。 */
  adapter?: { mode: string; packageDir?: string; error?: string }
}

export class DefaultRouter implements Router {
  private readonly options: RouterOptions
  private readonly now: () => number
  private readonly newId: () => string

  constructor(options: RouterOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.newId = options.newId ?? (() => randomUUID())
  }

  async send(request: SendRequest): Promise<SendReceipt> {
    const { config, transport, registry } = this.options

    const from = normalizeIdentity(request.from)
    if (from === '') throw new BusError('E_TARGET_NOT_FOUND', '缺少发送方 from（需要当前 session id / agent id）')

    const kind: BusKind = request.kind ?? 'text'
    if (!VALID_KINDS.includes(kind)) {
      throw new BusError('E_PAYLOAD_EMPTY', `kind 只接受 ${VALID_KINDS.join(' | ')}，实际 ${String(request.kind)}`)
    }

    const payload = normalizePayload(request.payload)
    if (payload.text.trim() === '') throw new BusError('E_PAYLOAD_EMPTY', 'payload 不能为空')
    if (payload.text.length > config.router.maxPayloadChars) {
      throw new BusError(
        'E_PAYLOAD_TOO_LARGE',
        `payload 超过上限 ${config.router.maxPayloadChars} 字符（实际 ${payload.text.length}）`,
      )
    }

    /** 回复一条非 request 消息时，把原消息 kind 记进 meta（可追溯，但不拒绝）。 */
    let metaOriginalKind: string | undefined

    // response 必须能关联回一条**真实存在**的消息：replyTo 指向一条已落库的消息。
    // 不强制那条消息一定是 kind=request —— openclaw 的 session send 也只要求「有回复对象」，
    // 人类在 UI 上点某条 text 直接回复同样是合理用法。原始 kind 记进 meta 便于排查。
    if (kind === 'response' || (request.replyTo !== undefined && request.replyTo.trim() !== '')) {
      if (request.replyTo === undefined || request.replyTo.trim() === '') {
        throw new BusError('E_REPLY_TARGET_MISSING', 'kind=response 必须带 replyTo（指向要回复的 message id）')
      }
      const original = await transport.get(request.replyTo.trim())
      if (original === undefined) {
        throw new BusError('E_REPLY_TARGET_MISSING', `replyTo 指向的消息不存在：${request.replyTo}`, {
          replyTo: request.replyTo,
        })
      }
      if (kind === 'response' && original.kind !== 'request') {
        // 保留可追溯性，但不拒绝：真实场景里回复一条 text / event 是常见操作。
        metaOriginalKind = original.kind
      }
    }

    const to = request.to.trim()
    if (to === '') throw new BusError('E_TARGET_NOT_FOUND', '缺少接收方 to（session id / agent id / "*"）')

    const meta =
      metaOriginalKind === undefined
        ? request.meta
        : { ...(request.meta ?? {}), originalKind: metaOriginalKind }

    // ── 广播 ──
    if (to === '*' || to === 'all') {
      if (!config.router.allowBroadcast) {
        throw new BusError('E_BROADCAST_DISABLED', '配置里 router.allowBroadcast=false，广播被禁用')
      }
      const targets = await registry.broadcastTargets(from)
      if (targets.length === 0) throw new BusError('E_BROADCAST_EMPTY', '广播没有任何可投递目标')
      return this.deliverMany(from, targets, kind, payload, { ...request, meta }, true)
    }

    // ── 单播 ──
    const hits = await registry.resolve(to)
    if (hits.length === 0) {
      throw new BusError(
        'E_TARGET_NOT_FOUND',
        `目标不存在：${to}。请用 session id，或让对方先 dsh_bus_register 报名后用它的名字。` +
          `（列表里那种 "11-08 15:49 · e9f8dca" 是派生显示名，不能用于寻址）`,
        { to },
      )
    }
    if (hits.length > 1) {
      const distinct = dedupe(hits)
      if (distinct.length > 1) {
        throw new BusError('E_AMBIGUOUS_TARGET', `目标 "${to}" 命中多个身份，请用更精确的 id`, {
          candidates: distinct.map((entry) => ({ id: entry.id, name: entry.name, source: entry.source })),
        })
      }
      return this.deliverMany(from, distinct, kind, payload, { ...request, meta })
    }
    return this.deliverMany(from, hits, kind, payload, { ...request, meta })
  }

  async history(query: {
    involving?: string
    to?: string
    from?: string
    unreadOnly?: boolean
    sinceTs?: number
    limit?: number
  } = {}): Promise<BusMessage[]> {
    return this.options.transport.list(query)
  }

  async markRead(target: string, ids: string[]): Promise<number> {
    return this.options.transport.markRead(target, ids)
  }

  async snapshot(owner: string, limit = 100): Promise<BusSnapshot> {
    const { transport, registry, config } = this.options
    const agents = await registry.list()
    const unread = await transport.unread([owner])
    const messages = await transport.list({ involving: owner, limit })
    const sources = await registry.sources()
    const diagnostics = this.options.dshTeam?.diagnostics?.()
    return {
      enabled: config.enabled,
      owner,
      agents,
      unread,
      messages,
      sources: sources.map((item) => ({ source: item.source, available: item.available, count: item.count })),
      adapter: diagnostics,
    }
  }

  /** 单条/多条广播共用的落库 + 投递。 */
  private async deliverMany(
    from: string,
    targets: AgentEntry[],
    kind: BusKind,
    payload: BusPayload,
    request: SendRequest,
    isBroadcast = false,
  ): Promise<SendReceipt> {
    const { transport } = this.options
    // 广播批次：只要是从 "*" 进来的，即使只解析出 1 个目标也带 broadcastId ——
    // 这样「广播」与「单播恰好只有一个接收者」在数据上仍可分。
    const broadcastId = isBroadcast ? this.newId() : undefined
    const ts = this.now()
    const messages: BusMessage[] = targets.map((target, index) => ({
      // 广播时每条一个 id（各自独立已读状态），但共享 broadcastId 便于追踪同一批。
      id: this.newId(),
      ts: ts + index,
      kind,
      fromId: from,
      fromName: request.meta?.['fromName'] === undefined ? undefined : String(request.meta['fromName']),
      fromSource: 'unknown',
      toId: target.id,
      toName: target.name,
      replyTo: request.replyTo?.trim() || undefined,
      broadcastId,
      payload,
      meta: request.meta,
    }))

    // 落库失败 = 整体失败（绝不出现「以为发了其实没存」）
    const written = await transport.appendMany(messages)

    const deliveries: DeliveryResult[] = []
    for (let index = 0; index < written.length; index += 1) {
      const message = written[index]
      const target = targets[index]
      deliveries.push(await this.deliverOne(message, target, request))
    }

    return { ok: true, messages: written, deliveries }
  }

  /** 把已落库的消息尽力投递/唤醒到目标来源；失败不回滚消息（durable 语义）。 */
  private async deliverOne(message: BusMessage, target: AgentEntry, request: SendRequest): Promise<DeliveryResult> {
    const base: DeliveryResult = {
      to: target.id,
      toName: target.name,
      toSource: target.source,
      messageId: message.id,
      mode: 'durable',
    }

    // ── ① dsh-team 目标：走它自己的 inbox + 唤醒 ──
    if (target.source === 'dsh-team' && this.options.dshTeam !== undefined) {
      const content = formatContent(message)
      try {
        const delivery = await this.options.dshTeam.deliver(target, fromLabel(message), content, undefined)
        return { ...base, mode: delivery.mode, detail: delivery.detail }
      } catch (error) {
        this.options.logger?.warn?.(`[dsh-session-send] 投递到 ${target.id} 失败（消息已落库）：${String(error)}`)
        return { ...base, mode: 'failed', detail: String(error) }
      }
    }

    // ── ② 普通 DSH 会话：**真正推给它**，不是只落库 ──
    //    这是「7 个平级会话互相流转」的核心：agent.steer() 直接往目标会话自己的
    //    收件箱追加，没有任何父子关系限制（详见 src/transport/session-push.ts）。
    if (this.options.sessions !== undefined) {
      const mode = deliveryModeOf(request)
      try {
        const pushed = await this.options.sessions.push(target.id, formatContent(message), mode)
        const mapped = mapOutcome(pushed.outcome)
        return { ...base, mode: mapped, detail: pushed.detail }
      } catch (error) {
        this.options.logger?.warn?.(`[dsh-session-send] 推送到 ${target.id} 失败（消息已落库）：${String(error)}`)
        return { ...base, mode: 'failed', detail: String(error) }
      }
    }

    // ── ③ 没有投递器：只能落库。这是降级路径，说明装配不完整。 ──
    return {
      ...base,
      detail: `${target.source} 目标：已落库，但未接入跨会话投递器（只能等对端自己来取）`,
    }
  }
}

/** request.meta.deliveryMode 决定用 steer / followup / notify；默认 steer。 */
function deliveryModeOf(request: SendRequest): DeliveryMode {
  const raw = request.meta?.['deliveryMode']
  return raw === 'followup' || raw === 'notify' || raw === 'steer' ? raw : 'steer'
}

/** SessionPusher 的 outcome 映射到 DeliveryResult.mode。 */
function mapOutcome(outcome: 'steered' | 'queued' | 'notified' | 'absent'): DeliveryResult['mode'] {
  switch (outcome) {
    case 'steered':
      return 'steered'
    case 'queued':
      return 'queued'
    case 'notified':
      return 'queued'
    case 'absent':
    default:
      return 'durable'
  }
}

function dedupe(entries: AgentEntry[]): AgentEntry[] {
  const seen = new Set<string>()
  const result: AgentEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}

function normalizeIdentity(value: string): string {
  const trimmed = (value ?? '').trim()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

function normalizePayload(value: BusPayload | string): BusPayload {
  if (typeof value === 'string') return { text: value }
  if (value === undefined || value === null) return { text: '' }
  return { text: typeof value.text === 'string' ? value.text : String(value.text ?? ''), data: value.data }
}

/** 投递给 dsh-team 的正文：带上 kind / from / message id / replyTo，对方模型能直接读懂。 */
/**
 * 把一条消息渲染成推给目标会话的正文。
 *
 * ── 为什么带「怎么回复」的说明 ────────────────────────────────────
 * 真实事故：消息成功送达、目标也真的处理了，但 5 个会话里 4 个把回答
 * **只写在自己的对话里**，没有调 `dsh_bus_send` 发回去。发送方看到的是
 * 「6 条消息只回来 1 条」，像是投递失败 —— 其实是接收方不知道要回。
 *
 * 所以正文末尾固定附一段回复指引：告诉它用哪个工具、`to` 填什么、
 * 以及「只在自己对话里说等于没回」。这段话很短，但决定消息闭环成不成立。
 */
export function formatContent(message: BusMessage): string {
  const sender = message.fromName ?? message.fromId
  const header = [
    `[dsh-bus ${message.kind}]`,
    `from=${sender}`,
    `message_id=${message.id}`,
    message.replyTo === undefined ? undefined : `reply_to=${message.replyTo}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ')
  const data =
    message.payload.data === undefined ? '' : `\n\n<data>${JSON.stringify(message.payload.data)}</data>`

  // 回复指引：用 replyTo 最省事（收件人自动取原发送方），也说明按名字回的写法。
  const howToReply = [
    '',
    '---',
    `要回复这条，调用 dsh_bus_reply({ replyTo: "${message.id}", text: "..." })；`,
    `或者 dsh_bus_send({ to: "${sender}", text: "..." })。`,
    '**只在你自己这一轮里回答不算回复** —— 发送方看不到，必须走上面两个工具。',
    '不需要回复就忽略本段。',
  ].join('\n')

  return `${header}\n\n${message.payload.text}${data}${howToReply}`
}

function fromLabel(message: BusMessage): string {
  return message.fromName ?? message.fromId
}

export { BusError }
