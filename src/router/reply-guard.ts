/**
 * 回传守卫（reply guard）—— 让「收到消息不回」在机制上跑不掉。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * 真实事故：发送方给 6 个会话各发一条，全部返回 `steered`。
 * 但只有 1 个把回答发了回来。查证发现另外 4 个**都收到了、都处理了、
 * 都写了答案** —— 答案写在自己的对话里，没有调 `dsh_bus_send`。
 *
 * 第一版修法是在消息正文里附「怎么回复」的说明。那仍然依赖模型读进去并照做，
 * 属于「提醒」。而用户要的是**机制**：不靠模型记得。
 *
 * ── 机制怎么工作 ────────────────────────────────────────────────
 *   ① `agent/inbox/claimed` —— 一条 bus 消息被某个会话取走时，记账：
 *      「这个会话欠 `fromId` 一条回复（message_id=...）」。
 *   ② `tools/result` —— 每次工具调用后检查：如果这个会话调了
 *      `dsh_bus_send` / `dsh_bus_reply`，并且目标就是债主，则销账。
 *   ③ `agent/turn-stopping` —— 轮次即将结束时检查欠账：
 *      还欠着，就**自动把一条提醒注入它自己的收件箱**并唤醒，
 *      让它继续跑一轮去回。这样「不回」不会静默通过。
 *
 * 第 ③ 步是机制的核心：它不依赖模型自觉，是插件在轮次边界上主动介入。
 *
 * ── 安全边界 ────────────────────────────────────────────────────
 *   · 只处理**本插件自己发出的**消息（按 message id 前缀/来源识别），
 *     不干扰任何人机对话。
 *   · 每个 (session, message) 最多催 `MAX_NUDGES` 次，避免无限循环。
 *   · 债主必须是本插件知道的会话；不确定就不催。
 *   · 自动回复（`autoReply`）默认关闭 —— 催而不是代它回，
 *     因为代回会伪造对方的发言，那是更糟的错误。
 */

/** 一条待回复的欠账。 */
export interface ReplyDebt {
  /** 原消息 id。 */
  messageId: string
  /** 该回给谁（原发送方 id）。 */
  replyToId: string
  /** 该回给谁（显示名，用于提醒文案）。 */
  replyToName: string
  /** 欠账产生时间。 */
  at: number
  /** 已经催过几次。 */
  nudges: number
}

export interface ReplyGuardOptions {
  /** 日志。 */
  logger?: { info?(message: string): void; warn?(message: string): void }
  /** 每个欠账最多催几次（默认 2）。 */
  maxNudges?: number
  /**
   * 催办文案生成器。默认给出工具名与参数，方便模型照做。
   * 抽成参数是为了测试能断言，也方便将来按语言调整。
   */
  nudgeText?: (debt: ReplyDebt) => string
  /** 当前时间（测试注入）。 */
  now?: () => number
}

/** 默认催办文案。 */
export function defaultNudgeText(debt: ReplyDebt): string {
  return [
    `[dsh-bus 催办] 你收到的那条消息（message_id=${debt.messageId}，来自 ${debt.replyToName}）还没有回复。`,
    '',
    `如果你已经处理完了，请把结论发回去：`,
    `  dsh_bus_reply({ replyTo: "${debt.messageId}", text: "<你的结论>" })`,
    `或者 dsh_bus_send({ to: "${debt.replyToId}", text: "<你的结论>" })`,
    '',
    `如果这条消息不需要回复（例如只是通知），调用：`,
    `  dsh_bus_send({ to: "${debt.replyToId}", text: "无需回复", kind: "event" })`,
    `或直接忽略本条催办 —— 它不会再来。`,
  ].join('\n')
}

/**
 * 回传守卫的状态机。
 *
 * 与宿主的耦合只通过三个入口方法（`onMessageClaimed` / `onToolResult` /
 * `onTurnStopping`），事件注册在 index.ts 里做 —— 这样这个类可以纯单测。
 */
export class ReplyGuard {
  private readonly debts = new Map<string, ReplyDebt>()
  private readonly options: ReplyGuardOptions

  constructor(options: ReplyGuardOptions = {}) {
    this.options = options
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private key(sessionId: string, messageId: string): string {
    return `${sessionId}::${messageId}`
  }

  /**
   * ① 一条消息被会话取走 —— 记账。
   *
   * 只记「别人发给它的」：如果 `fromId === sessionId` 是自己发的，不记。
   */
  onMessageClaimed(sessionId: string, message: {
    id: string
    fromId?: string
    fromName?: string
    toId?: string
  }): void {
    const id = String(message.id ?? '').trim()
    const fromId = String(message.fromId ?? '').trim()
    if (id === '' || fromId === '' || sessionId === '') return
    // 自己发的不算欠账
    if (fromId === sessionId) return
    // 收件人不是它的也不记（防御）
    if (message.toId !== undefined && message.toId !== sessionId) return

    this.debts.set(this.key(sessionId, id), {
      messageId: id,
      replyToId: fromId,
      replyToName: message.fromName ?? fromId,
      at: this.now(),
      nudges: 0,
    })
    this.options.logger?.info?.(
      `[dsh-session-send] ${sessionId} 欠 ${message.fromName ?? fromId} 一条回复（msg=${id}）`,
    )
  }

  /**
   * ② 工具调用结果 —— 销账。
   *
   * 认两种情况：
   *   · `dsh_bus_reply` 且 `replyTo` 命中某条欠账
   *   · `dsh_bus_send` 且 `to` 命中该欠账的债主
   *
   * 只要命中一条，就把对应欠账清掉 —— 说明它真的回了。
   */
  onToolResult(sessionId: string, toolName: string, args: unknown): void {
    if (sessionId === '' || toolName === '') return
    if (toolName !== 'dsh_bus_reply' && toolName !== 'dsh_bus_send') return

    const input = (args ?? {}) as Record<string, unknown>
    const replyTo = typeof input.replyTo === 'string' ? input.replyTo.trim() : ''
    const to = typeof input.to === 'string' ? input.to.trim() : ''

    for (const [key, debt] of this.debts) {
      if (!key.startsWith(`${sessionId}::`)) continue
      const settled =
        (replyTo !== '' && replyTo === debt.messageId) ||
        (to !== '' && (to === debt.replyToId || to === debt.replyToName))
      if (!settled) continue
      this.debts.delete(key)
      this.options.logger?.info?.(`[dsh-session-send] ${sessionId} 已回复 ${debt.replyToName}，销账`)
    }
  }

  /**
   * ③ 轮次即将结束 —— 查欠账，该催就催。
   *
   * @returns 需要注入的催办文案（空数组表示不欠账）
   */
  onTurnStopping(sessionId: string): ReplyDebt[] {
    if (sessionId === '') return []
    const max = this.options.maxNudges ?? 2
    const due: ReplyDebt[] = []

    for (const [key, debt] of this.debts) {
      if (!key.startsWith(`${sessionId}::`)) continue
      if (debt.nudges >= max) {
        // 催够了还没回：销账，避免无限循环。但留下 warn，让日志可查。
        this.debts.delete(key)
        this.options.logger?.warn?.(
          `[dsh-session-send] ${sessionId} 催了 ${debt.nudges} 次仍未回复 ${debt.replyToName}，放弃（msg=${debt.messageId}）`,
        )
        continue
      }
      debt.nudges += 1
      due.push({ ...debt })
    }
    return due
  }

  /** 催办文案。 */
  nudgeText(debt: ReplyDebt): string {
    return (this.options.nudgeText ?? defaultNudgeText)(debt)
  }

  /** 当前欠账（诊断用）。 */
  pending(sessionId?: string): ReplyDebt[] {
    const all = [...this.debts.values()]
    if (sessionId === undefined) return all
    return all.filter((d) => this.debts.has(this.key(sessionId, d.messageId)))
  }

  /** 清空（测试/热重载用）。 */
  reset(): void {
    this.debts.clear()
  }
}
