/**
 * session-transport —— **真正的跨会话投递**。
 *
 * 这是本插件的核心：让 7 个**各自独立**的会话（loop 项目里管管线、跑章、门禁…）
 * 通过 session id 互相唤醒，不需要人手工复制粘贴提示词。
 *
 * ── 为什么不能用 subagents.sendMessage ────────────────────────────────
 * 那个 API 的契约明确写着只能发给「直接父级或直接 continuable 子级」：
 *   "Steer one model-authored message to the sender's direct parent or direct
 *    continuable child."
 * 而这里 7 个会话彼此是**平级**的，谁也不是谁的父子 —— 用它必然被
 * adjacency 校验拒掉。
 *
 * ── 实际用的机制（读宿主源码确认过）────────────────────────────────
 * `ctx.agents.get(sessionId)` 拿到的活 Agent 上有一组方法：
 *
 *   steer(input)     → send(input, 'next-step', true)   注入到**下一步**并唤醒
 *   followup(input)  → send(input, 'next-turn', true)   作为**下一轮**并唤醒
 *   inject(input)    → send(input, 'next-step', false)  注入但不唤醒
 *   wakeDriver()     → 若空闲则启动 driver
 *
 * `send()` 的实现是 `this.inbox.splice(target, Infinity, 0, [message])` ——
 * 直接往目标会话自己的收件箱追加，**没有任何父子关系校验**。
 * 这就是 openclaw `session send` 的 `mode` 在 DSH 侧的真实对应：
 *
 *   openclaw mode:notify   ≈ inject   （不唤醒）
 *   openclaw mode:steer    ≈ steer    （注入当前/下一步并唤醒）
 *   openclaw mode:followup ≈ followup （作为下一轮并唤醒）
 *
 * 目标不在本进程（未激活）时 `agents.get()` 返回 undefined：
 * 此时只能落库（durable），等它下次被打开时由 `dsh_bus_inbox` 取走。
 * 这条降级路径必须保留，否则「发给一个没打开的会话」就变成永久失败。
 *
 * 分层：本文件只依赖 types + 宿主服务访问器，不认识 transport / registry / router 实现。
 */
import { BusError } from '../types.ts'

/** 投递模式：与 openclaw session send 的 mode 对应。 */
export type DeliveryMode = 'steer' | 'followup' | 'notify'

export interface SessionPushResult {
  /** 目标是否在本进程内活着（false = 只能落库等它下次打开）。 */
  live: boolean
  /** 实际做到的事：steered = 已注入并唤醒；queued = 已作为下一轮入队；notified = 只注入不唤醒；absent = 目标不在本进程。 */
  outcome: 'steered' | 'queued' | 'notified' | 'absent'
  detail?: string
  /** 目标会话的 id（回显，便于日志核对）。 */
  targetId: string
}

export interface SessionPusherOptions {
  /** 宿主 ctx（取 agents / llm）。 */
  ctx: any
  logger?: { info?(message: string): void; warn?(message: string): void }
}

/**
 * 把一段文本推进某个**活着的** DSH 会话。
 *
 * 失败不抛（除了参数缺失）—— 调用方已经先落库了，这里只是「尽力唤醒」。
 * 返回结构说明发生了什么，UI / 工具结果都能直接展示。
 */
export class SessionPusher {
  private readonly options: SessionPusherOptions
  private createUserMessage: ((input: any) => any) | undefined
  private loaderTried = false

  constructor(options: SessionPusherOptions) {
    this.options = options
  }

  /** 目标是否在本进程内活着（只查，不投递）。 */
  isLive(sessionId: string): boolean {
    return this.agentOf(sessionId) !== undefined
  }

  /**
   * 推进一条消息。
   *
   * @param sessionId 目标会话 id
   * @param text      正文（调用方负责已含 kind / from / replyTo 头）
   * @param mode      steer（默认）| followup | notify
   * @param options   `resume: true`（默认）时，目标未激活会尝试冷启动它；
   *                  `sender` 是真实发送者（写进消息 source，回传守卫靠它认债主）
   */
  async push(
    sessionId: string,
    text: string,
    mode: DeliveryMode = 'steer',
    options: { resume?: boolean; sender?: { id?: string; name?: string } } = {},
  ): Promise<SessionPushResult> {
    const target = String(sessionId ?? '').trim()
    if (target === '') throw new BusError('E_TARGET_NOT_FOUND', '缺少目标 session id')
    if (text.trim() === '') throw new BusError('E_PAYLOAD_EMPTY', '要推送的正文为空')

    let agent = this.agentOf(target)
    let resumed = false
    if (agent === undefined && options.resume !== false) {
      // 目标不在本进程：尝试冷启动（把持久化会话载入内存）
      const resumeResult = await this.resume(target)
      agent = resumeResult.agent
      resumed = resumeResult.resumed
      if (agent === undefined) {
        return {
          live: false,
          outcome: 'absent',
          targetId: target,
          detail:
            resumeResult.error ??
            '目标会话不在本进程内且无法冷启动，消息已落库，待它下次打开时通过 dsh_bus_inbox 取走',
        }
      }
    }
    if (agent === undefined) {
      return {
        live: false,
        outcome: 'absent',
        targetId: target,
        detail: '目标会话不在本进程内（未激活），消息已落库，待它下次打开时通过 dsh_bus_inbox 取走',
      }
    }

    const message = await this.buildMessage(text, target, options.sender)
    try {
      const suffix = resumed ? '（已冷启动该会话）' : ''
      if (mode === 'notify') {
        // 不唤醒：只放进收件箱，等它下一次自己开始一轮时看到。
        if (typeof agent.inject === 'function') agent.inject(message)
        else agent.send(message, 'next-step', false)
        return { live: true, outcome: 'notified', targetId: target, detail: `已注入收件箱，未唤醒目标${suffix}` }
      }

      // ── 冷启动后的特殊处理 ──
      // 刚 resume 出来的 Agent，phase 会短暂处于过渡态：
      // steer() 内部的 wakeDriver() 看到 phase 非 idle 就只设 wakeRequested 而不真正驱动，
      // 结果是 turn/start 后立刻 turn/end —— inbox 里的消息被 claim 了却不会写成
      // user/message 事件，目标会话"什么都没看到"。
      //
      // 所以冷启动后不用 steer，改为：
      //   ① followup（进 next-turn 队列，下一轮必然被 claim）
      //   ② 再显式 wakeDriver() 把驱动拉起来（幂等：已在跑就只标记 wakeRequested）
      if (resumed) {
        if (mode === 'notify') {
          if (typeof agent.inject === 'function') agent.inject(message)
          else agent.send(message, 'next-step', false)
          return { live: true, outcome: 'notified', targetId: target, detail: '已冷启动该会话，消息放入收件箱但未唤醒' }
        }
        if (typeof agent.followup === 'function') agent.followup(message)
        else agent.send(message, 'next-turn', true)

        // 冷启动后的驱动是不稳定的：wakeDriver 可能在过渡态只设 wakeRequested。
        // 所以轮询重试几次 —— 每次只在真正 idle 时才会生效，因此是安全的。
        const woken = await this.wakeUntilIdle(agent)
        return {
          live: true,
          outcome: 'queued',
          targetId: target,
          detail: woken
            ? '已冷启动该会话并作为下一轮投递（已唤醒）'
            : '已冷启动该会话，消息在队列中（唤醒未生效，等它下次活动时取走）',
        }
      }

      if (mode === 'followup') {
        if (typeof agent.followup === 'function') agent.followup(message)
        else agent.send(message, 'next-turn', true)
        return { live: true, outcome: 'queued', targetId: target, detail: `已作为下一轮入队并唤醒${suffix}` }
      }

      // steer：注入并唤醒。运行中的目标在下一个 step 边界看到。
      if (typeof agent.steer === 'function') agent.steer(message)
      else agent.send(message, 'next-step', true)
      return { live: true, outcome: 'steered', targetId: target, detail: `已注入并唤醒目标${suffix}` }
    } catch (error) {
      // 唤醒失败不代表消息丢了（已落库），如实报告。
      this.options.logger?.warn?.(`[dsh-session-send] 推送到 ${target} 失败：${String(error)}`)
      return {
        live: true,
        outcome: 'notified',
        targetId: target,
        detail: `唤醒失败，消息已落库：${String(error)}`,
      }
    }
  }

  /**
   * 冷启动一个持久化会话。
   *
   * 用宿主的 `agentLoop.resume(ownerCtx, { resumeSessionId })` ——
   * 这是官方「从持久化恢复一个 Agent」的入口，不自己造会话。
   * 拿不到 agentLoop 或恢复失败都返回 undefined，让上层降级为 durable。
   */
  private async resume(sessionId: string): Promise<{ agent?: any; resumed: boolean; error?: string }> {
    const loop = this.options.ctx?.get?.('agentLoop') ?? this.options.ctx?.agentLoop
    if (typeof loop?.resume !== 'function') {
      return { resumed: false, error: '宿主未提供 agentLoop.resume，无法冷启动目标会话' }
    }
    try {
      const handle = await loop.resume(this.options.ctx, { resumeSessionId: sessionId })
      const agent = handle?.agent ?? handle
      if (agent === undefined || agent === null) {
        return { resumed: false, error: '冷启动返回空句柄' }
      }
      this.options.logger?.info?.(`[dsh-session-send] 冷启动会话成功：${sessionId}`)
      return { agent, resumed: true }
    } catch (error) {
      this.options.logger?.warn?.(`[dsh-session-send] 冷启动 ${sessionId} 失败：${String(error)}`)
      return { resumed: false, error: `冷启动失败：${String(error)}` }
    }
  }

  /**
   * 反复尝试唤醒，直到它真的开始跑（或超时）。
   *
   * `wakeDriver()` 只在 `phase.kind === 'idle'` 时真正启动一轮；
   * 刚 resume 的 Agent 会短暂处于过渡态，第一次调用往往只设 `wakeRequested`。
   * 轮询重试是安全的：非 idle 时它本来就只会标记，不会重复起轮。
   *
   * @returns 是否观察到它离开了 idle（= 真的被唤醒）
   */
  private async wakeUntilIdle(agent: any, attempts = 6, intervalMs = 150): Promise<boolean> {
    if (typeof agent?.wakeDriver !== 'function') return false
    for (let i = 0; i < attempts; i += 1) {
      try {
        agent.wakeDriver()
      } catch (error) {
        this.options.logger?.warn?.(`[dsh-session-send] wakeDriver 失败：${String(error)}`)
        return false
      }
      // 给驱动一点时间切到 running
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      try {
        if (agent.phase?.kind !== 'idle') return true
      } catch {
        /* phase 读不到就继续试 */
      }
    }
    return false
  }

  private agentOf(sessionId: string): any {
    try {
      const agents = this.options.ctx?.get?.('agents') ?? this.options.ctx?.agents
      return agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * 构造一条 user 角色消息。
   *
   * 用宿主的 `createUserMessage`（它做 deepFreeze + 生成稳定 id），
   * 拿不到就退化为同形状的普通对象 —— 那条路径足够让 inbox 接受。
   *
   * `source` 里必须带上**真实发送者**（`fromId` / `fromName`）：
   * 回传守卫靠它判断「这条消息是谁发的、欠谁一条回复」。
   * 早先这里写死 `from: 'dsh-bus'`，导致守卫把所有消息的债主都认成
   * `'dsh-bus'`，销账永远不命中 —— 于是连发送者自己也被催办。
   */
  private async buildMessage(
    text: string,
    target: string,
    sender?: { id?: string; name?: string },
  ): Promise<any> {
    const content = [{ type: 'text', text }]
    const source: Record<string, unknown> = {
      kind: 'user',
      origin: 'dsh-session-send',
      from: sender?.id ?? 'dsh-bus',
      target,
    }
    if (sender?.name !== undefined && sender.name !== '') source['fromName'] = sender.name
    const factory = await this.resolveFactory()
    if (factory !== undefined) {
      try {
        return factory({ content, source })
      } catch (error) {
        this.options.logger?.warn?.(`[dsh-session-send] createUserMessage 失败，用最小形状代替：${String(error)}`)
      }
    }
    return { id: `bus-${Date.now()}-${Math.random().toString(16).slice(2)}`, role: 'user', content, source }
  }

  private async resolveFactory(): Promise<((input: any) => any) | undefined> {
    if (this.createUserMessage !== undefined) return this.createUserMessage
    if (this.loaderTried) return undefined
    this.loaderTried = true

    // ① 宿主 llm 服务上可能直接挂着（某些组合会暴露）
    try {
      const llm = this.options.ctx?.get?.('llm')
      if (typeof llm?.createUserMessage === 'function') {
        this.createUserMessage = llm.createUserMessage.bind(llm)
        return this.createUserMessage
      }
    } catch {
      /* 继续 */
    }

    // ② 从宿主包直接 import —— **这是主路径**。
    //    ctx.llm 服务只有 adapters/directory，没有消息构造器；
    //    必须拿 @deepseek-ai/dsh-llm 的导出，它做了 deepFreeze + 生成稳定 id。
    //    用最小形状的对象顶替会出问题：inbox 接受它，但不会被写成正常的
    //    user/message 事件 —— 目标会话的对话历史里看不到这条消息。
    try {
      const hostModules: any = await import('../host-modules.ts')
      const mod = await hostModules.importHostPackage('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') {
        this.createUserMessage = mod.createUserMessage as (input: any) => any
        return this.createUserMessage
      }
    } catch {
      /* 继续 */
    }

    this.options.logger?.warn?.(
      '[dsh-session-send] 未能解析 @deepseek-ai/dsh-llm 的 createUserMessage，' +
        '将用最小形状消息代替（目标会话可能看不到该消息的对话记录）',
    )
    return undefined
  }
}
