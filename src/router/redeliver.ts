/**
 * redeliver —— **重发器**：接收方模型没配好时，把没能真正处理的消息留下来，
 * 等接收方被重新激活（模型配好后自然会发生）时自动重新投递。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * 真实场景：发送方 `dsh_bus_send` 返回了 `steered/queued`，消息已落库也推进了
 * 接收方的 inbox。但接收方会话因为 **模型/provider 没配置好**，第一轮直接
 * `has no provider/model` 失败 —— 那条消息**没有被真正处理**（没成 user/message
 * 事件、没调 dsh_bus_reply）。等模型配好、该会话被重新激活，原来那条消息已经
 * 被 inbox claim 掉了，**不会自动再来**。发送方以为发出去了，接收方根本没收到。
 *
 * ── 「未处理」怎么判定 ──────────────────────────────────────────
 * 一条 bus 消息只要**还没被接收方标为已读**（`dsh_bus_inbox(markRead:true)` /
 * UI「全部已读」），就说明它还没被真正处理。`markRead` 只会被显式消费或 UI
 * 触发，投递器 `steer/followup` 推进 inbox **不会**清除 unread —— 这是可靠的判据。
 *
 * ── 触发时机 ────────────────────────────────────────────────────
 * 宿主 `agent/created` 事件 = 一个会话被创建/激活（= 它的模型现在可用了）。
 * 此时把该会话名下的未处理 bus 消息重新 `push` 一次。这正好对上
 * 「模型配好了，之前欠的消息该补发」。
 *
 * ── 安全边界 ────────────────────────────────────────────────────
 *  · 默认**关闭**（config.router.redeliver.enabled=false）—— 主动补发不该默认开。
 *  · 每条消息最多 `maxAttempts` 次重发，超限放弃（防风暴 / 防无限循环）。
 *  · 每轮激活只对「当时未读」的消息重发一次；同一条不重复推。
 *  · 只处理本插件发出的 bus 消息，不碰人机对话。
 */
import type { BusMessage } from '../types.ts'
import type { Transport } from '../transport/transport.ts'
import type { DeliveryMode, SessionPusher } from '../transport/session-push.ts'

export interface RedeliverOptions {
  /** 总开关与次数上限（来自 config.router.redeliver）。 */
  enabled: boolean
  maxAttempts: number
  /** 未处理消息的持久存储（查未读用）。 */
  transport: Transport
  /** 把消息重新推进目标（复用 SessionPusher）。 */
  sessions: SessionPusher
  /** 解析一条消息该用哪种投递模式（与 router 一致：meta.deliveryMode）。 */
  deliveryMode: (message: BusMessage) => DeliveryMode
  logger?: { info?(message: string): void; warn?(message: string): void }
  /** 测试注入时钟。 */
  now?: () => number
}

/**
 * redeliverer 状态机。
 *
 * 与宿主的耦合只在 `onAgentCreated` 一个入口；具体重发走 `sessions.push`。
 * 判定「未处理」用 transport 的 unread（宿主机数据，不依赖内存态）。
 */
export class Redeliverer {
  private readonly options: RedeliverOptions
  /** 防止同一轮激活内重复推同一条：key = `${targetId}::${messageId}`。 */
  private readonly recent = new Set<string>()
  /** 每条已登记的消息已重发次数（跨激活累计，受 maxAttempts 约束）。 */
  private readonly attempts = new Map<string, number>()

  constructor(options: RedeliverOptions) {
    this.options = options
  }

  private logger(): RedeliverOptions['logger'] | undefined {
    return this.options.logger
  }

  /**
   * 一个会话被创建/激活 —— 若它名下有未处理的 bus 消息，重新投递。
   *
   * `agentId` 来自 `agent/created` 事件的 agent.id；对不上本项目会话的
   * transport 查不到未读数，自然空转。
   */
  async onAgentCreated(agentId: string): Promise<void> {
    if (!this.options.enabled) return
    const target = String(agentId ?? '').trim()
    if (target === '') return

    // 该会话名下的未读消息 = 还没被真正处理的消息
    let unreads: BusMessage[]
    try {
      unreads = await this.options.transport.list({ to: target, unreadOnly: true })
    } catch (error) {
      this.logger()?.warn?.(`[dsh-session-send] 查询 ${target} 的未处理消息失败：${String(error)}`)
      return
    }
    if (unreads.length === 0) return

    for (const message of unreads) {
      const key = `${target}::${message.id}`
      // 同一轮激活内不重复推
      if (this.recent.has(key)) continue
      // 达到重发上限就放弃（记录 warn 可查，不再推）
      const done = this.attempts.get(message.id) ?? 0
      if (done >= this.options.maxAttempts) {
        this.logger()?.warn?.(
          `[dsh-session-send] ${target} 的消息 ${message.id} 已重发 ${done} 次仍未处理，放弃（超过 maxAttempts=${this.options.maxAttempts}）`,
        )
        continue
      }

      this.recent.add(key)
      this.attempts.set(message.id, done + 1)
      await this.deliverOne(message)
    }
  }

  /** 把一条未处理消息重新推进目标；失败只告警，不外抛（不该影响宿主）。 */
  private async deliverOne(message: BusMessage): Promise<void> {
    const target = message.toId
    const mode = this.options.deliveryMode(message)
    try {
      const pushed = await this.options.sessions.push(target, message.payload.text, mode, {
        sender: { id: message.fromId, name: message.fromName },
      })
      this.logger()?.info?.(
        `[dsh-session-send] 重发 ${message.id} → ${target}（模型就绪后补发）：outcome=${pushed.outcome}${pushed.detail ? ` — ${pushed.detail}` : ''}`,
      )
    } catch (error) {
      this.logger()?.warn?.(
        `[dsh-session-send] 重发 ${message.id} → ${target} 失败（已尝试计数，仍可后续再试）：${String(error)}`,
      )
    }
  }

  /** 一轮激活处理结束后清理 recent（允许下一轮激活再次触发）。 */
  clearRound(): void {
    this.recent.clear()
  }

  /** 当前登记状态（诊断/测试用）。 */
  pending(): Array<{ messageId: string; attempts: number }> {
    return [...this.attempts.entries()].map(([messageId, attempts]) => ({ messageId, attempts }))
  }

  /** 清空（卸载/热重载用）。 */
  reset(): void {
    this.recent.clear()
    this.attempts.clear()
  }
}