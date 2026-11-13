/**
 * BusService —— 装配好的总线门面，UI 与 Host 工具都只调它。
 *
 * 职责边界：
 *  - 持有 config / transport / registry / router 四层的**实例**与生命周期；
 *  - 提供 enabled 门禁：未开启时所有操作返回 E_DISABLED，不做任何副作用；
 *  - 支持**热切换**：`reconfigure()` 换掉四层实例，不需要重启宿主
 *    （项目开关由 UI 一键写盘后调用它，见 ./control.ts）。
 *  - 不实现业务（解析/投递/落库都在各自层）。
 */
import type { AgentEntry, BusConfig, BusMessage, SendReceipt, SendRequest } from '../types.ts'
import { BusError } from '../types.ts'
import type { Transport } from '../transport/transport.ts'
import type { Registry } from '../registry/registry.ts'
import type { Router, BusSnapshot } from '../router/router.ts'
import type { SessionPusher } from '../transport/session-push.ts'
import type { DshTeamAdapter } from '../registry/dsh-team-adapter.ts'
import type { ProjectSwitchState } from './control.ts'

/** 四层实例 + 配置。热切换时整体替换。 */
export interface BusRuntime {
  config: BusConfig
  /** 项目根（workspace 路径）。 */
  projectRoot: string
  /** 项目级配置文件路径（`<workspace>/.dsh-bus.json`）。 */
  projectConfigPath: string
  transport: Transport
  registry: Registry
  router: Router
  /** 跨会话投递器（redeliver 等重复投递也用它）。 */
  sessions: SessionPusher
  dshTeam?: DshTeamAdapter
  warnings: string[]
  /** 项目配置文件是否存在。 */
  configPresent: boolean
  /** 项目配置文件是否读不出来（坏 JSON / 权限）。 */
  configDegraded: boolean
}

/**
 * 由装配层提供的「按项目根重新构建一份 runtime」。 */
export type RuntimeFactory = (projectRoot: string) => Promise<BusRuntime>

/**
 * 只读探测：读某个项目根此刻的开关状态，**不装配任何东西**。
 * 必须与 RuntimeFactory 分开 —— 装配会建 transport（sqlite 建目录与库文件），
 * 「看一眼状态」不能产生副作用。
 */
export type RuntimeProbe = (projectRoot: string) => Promise<ProjectSwitchState>

/**
 * 解析「这次调用属于哪个项目」。
 *
 * **这是关键设计**：项目根绝不能在一次装配里被定死。
 * 宿主是长期运行的，同一个进程里会有多个 workspace 的会话；
 * 谁在启动瞬间触发了装配，不该决定之后所有调用用哪个项目的配置。
 * 所以每次 send / history / snapshot 都重新问一次调用者是谁。
 */
export type ProjectResolver = (exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } }) => string | undefined

export class BusService {
  private runtime: BusRuntime | undefined
  private readonly factory: RuntimeFactory | undefined
  private readonly probe: RuntimeProbe | undefined
  private readonly resolveProject: ProjectResolver | undefined
  private readonly logger?: { info?(message: string): void; warn?(message: string): void }
  /** 正在切换时挡住并发切换，避免两个按钮各建一份 runtime。 */
  private switching: Promise<unknown> | undefined

  constructor(options: {
    factory?: RuntimeFactory
    probe?: RuntimeProbe
    resolveProject?: ProjectResolver
    initial?: BusRuntime
    logger?: { info?(message: string): void; warn?(message: string): void }
  } = {}) {
    this.factory = options.factory
    this.probe = options.probe
    this.resolveProject = options.resolveProject
    this.runtime = options.initial
    this.logger = options.logger
  }

  /**
   * 按调用者切到对应项目。
   *
   * 命中当前 runtime 就直接用；否则（调用者属于另一个 workspace）重装配。
   * 这样 7 个会话各自在不同项目里时，谁调工具就用谁自己的 `.dsh-bus.json`。
   */
  async useFor(
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<BusRuntime> {
    const requested = this.resolveProject?.(exec)
    if (requested === undefined || requested.trim() === '') {
      return this.requireRuntime()
    }
    const current = this.runtime
    if (current !== undefined && samePath(current.projectRoot, requested)) return current
    if (this.factory === undefined) return this.requireRuntime()
    this.logger?.info?.(`[dsh-session-send] 调用来自另一个项目，切换 runtime：${requested}`)
    return this.reconfigure(requested)
  }

  /** 当前装配的 runtime（未装配返回 undefined）。redeliver 等只读才有权直接访问。 */
  getRuntime(): BusRuntime | undefined {
    return this.runtime
  }

  async mount(runtime: BusRuntime): Promise<void> {
    this.runtime = runtime
    await runtime.transport.init()
  }

  async unmount(): Promise<void> {
    const current = this.runtime
    this.runtime = undefined
    await current?.transport.dispose().catch(() => undefined)
  }

  /**
   * 按项目根重新装配：重建四层实例并交换。
   * 旧 transport 在新 runtime 就绪后再 dispose，中途读请求不会读到已关闭的实现。
   */
  async reconfigure(projectRoot: string): Promise<BusRuntime> {
    if (this.factory === undefined) {
      throw new BusError('E_DISABLED', 'dsh-session-send 未提供 runtime 工厂，无法热切换')
    }
    // 串行化：并发点击只跑一次
    if (this.switching !== undefined) {
      await this.switching.catch(() => undefined)
    }
    const task = (async () => {
      const next = await this.factory!(projectRoot)
      await next.transport.init()
      const previous = this.runtime
      this.runtime = next
      if (previous !== undefined && previous !== next) {
        await previous.transport.dispose().catch(() => undefined)
      }
      this.logger?.info?.(
        `[dsh-session-send] ${projectRoot} 重新装配：${next.config.enabled ? '已启用' : '已关闭'}`,
      )
      return next
    })()
    this.switching = task
    try {
      return await task
    } finally {
      if (this.switching === task) this.switching = undefined
    }
  }

  /** 运行时状态快照（不含消息体）。 */
  status(): Record<string, unknown> {
    const runtime = this.runtime
    if (runtime === undefined) return { mounted: false, enabled: false }
    return {
      mounted: true,
      enabled: runtime.config.enabled,
      scope: runtime.config.scope,
      projectRoot: runtime.projectRoot,
      projectConfigPath: runtime.projectConfigPath,
      configPresent: runtime.configPresent,
      configDegraded: runtime.configDegraded,
      transport: runtime.transport.kind,
      sources: runtime.config.registry.sources,
      adapter: runtime.dshTeam?.diagnostics?.(),
      warnings: runtime.warnings,
      disabledReason: this.disabledReasonOf(runtime),
    }
  }

  /**
   * 状态快照（异步版）：先让 dsh-team adapter 完成模块加载，再报告**真实**模式。
   * 同步 status() 在首次调用时可能把 mailbox 误报成 fs-only（模块还没加载）。
   */
  async statusAsync(): Promise<Record<string, unknown>> {
    const runtime = this.runtime
    if (runtime !== undefined && runtime.dshTeam !== undefined) {
      const asyncDiagnostics = (runtime.dshTeam as any).diagnosticsAsync
      if (typeof asyncDiagnostics === 'function') {
        try {
          const adapter = await asyncDiagnostics.call(runtime.dshTeam)
          const base = this.status()
          return { ...base, adapter }
        } catch {
          /* 降级到同步版 */
        }
      }
    }
    return this.status()
  }

  /** 某个项目此刻的开关状态（供 UI 菜单直接渲染，不需要先切到该项目）。 */
  async projectState(projectRoot: string): Promise<ProjectSwitchState> {
    const current = this.runtime
    // 当前 runtime 就是这个项目：直接用运行时真值，避免读盘与运行时不一致。
    if (current !== undefined && samePath(current.projectRoot, projectRoot)) {
      return {
        projectRoot: current.projectRoot,
        projectConfigPath: current.projectConfigPath,
        present: current.configPresent,
        enabled: current.config.enabled,
        reason: this.disabledReasonOf(current),
        error: current.configDegraded ? '配置文件解析失败' : undefined,
      }
    }
    // 其它项目：**只读配置**，不装配。
    // 装配会建 transport（sqlite 会建目录与库文件）——「看一眼状态」不该产生任何副作用。
    if (this.probe === undefined) {
      throw new BusError('E_DISABLED', 'dsh-session-send 未提供项目探测，无法读取其它项目的状态')
    }
    return this.probe(projectRoot)
  }

  config(): BusConfig {
    return this.requireRuntime().config
  }

  /** 门禁：没开就统一报 E_DISABLED，UI 据此显示「未开启」。 */
  assertEnabled(runtime?: BusRuntime): BusRuntime {
    const target = runtime ?? this.requireRuntime()
    if (!target.config.enabled) {
      throw new BusError('E_DISABLED', this.disabledReasonOf(target) ?? '本项目未启用会话总线', {
        projectRoot: target.projectRoot,
        projectConfigPath: target.projectConfigPath,
      })
    }
    return target
  }

  async send(
    request: SendRequest,
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<SendReceipt> {
    const runtime = await this.useFor(exec)
    return this.assertEnabled(runtime).router.send(request)
  }

  async agents(
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<AgentEntry[]> {
    const runtime = await this.useFor(exec)
    return this.assertEnabled(runtime).registry.list()
  }

  /** 侧栏一次拉齐（未开启时也返回一份「关闭」快照，方便 UI 显示提示）。 */
  async snapshot(
    owner: string,
    limit = 100,
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<BusSnapshot> {
    const runtime = await this.useFor(exec)
    if (!runtime.config.enabled) {
      return {
        enabled: false,
        owner,
        // 带上「哪个项目没开」和「为什么」，否则调用方只能看到一个空列表，
        // 会以为插件坏了 —— 真实困惑。
        projectRoot: runtime.projectRoot,
        disabledReason: this.disabledReasonOf(runtime) ?? '本项目未启用会话总线',
        agents: [],
        unread: [{ target: owner, count: 0 }],
        messages: [],
        sources: [],
        adapter: runtime.dshTeam?.diagnostics?.(),
      }
    }
    return runtime.router.snapshot(owner, limit)
  }

  async history(
    query: {
      involving?: string
      to?: string
      from?: string
      unreadOnly?: boolean
      sinceTs?: number
      limit?: number
    },
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<BusMessage[]> {
    const runtime = await this.useFor(exec)
    return this.assertEnabled(runtime).router.history(query)
  }

  async markRead(
    target: string,
    ids: string[],
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<number> {
    const runtime = await this.useFor(exec)
    return this.assertEnabled(runtime).router.markRead(target, ids)
  }

  /** 取这次调用对应的 runtime（不校验开关 —— 登记名字不要求总线已开）。 */
  async runtimeFor(
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<BusRuntime> {
    return this.useFor(exec)
  }

  /** 取这次调用对应的注册表（用于校验目标是否属于本项目）。 */
  async registryFor(
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<Registry> {
    return (await this.useFor(exec)).registry
  }

  /**
   * 某个会话是否属于本次调用所在的项目。
   *
   * 与 `registry.resolve()` 的区别：这里**包含未报名的会话**。
   * 报名本身需要这个判断 —— 用 resolve 会形成死循环（未报名就查不到，
   * 查不到就不许报名）。
   */
  async sessionBelongsToProject(
    sessionId: string,
    exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
  ): Promise<boolean> {
    const runtime = await this.useFor(exec)
    const registry = runtime.registry as unknown as { listAll?: () => Promise<Array<{ id: string }>> }
    if (typeof registry.listAll !== 'function') {
      // 其它 provider 没有 listAll：退回到 resolve（它们通常不要求报名）
      const hits = await runtime.registry.resolve(sessionId)
      return hits.length > 0
    }
    const all = await registry.listAll()
    return all.some((entry) => entry.id === sessionId)
  }

  private disabledReasonOf(runtime: BusRuntime): string | undefined {
    if (runtime.config.enabled) return undefined
    if (runtime.configDegraded) return '项目配置解析失败，已强制关闭'
    // 默认放行：只有显式 enabled:false 才关。走到这里一定是显式关或降级关。
    return `${runtime.projectConfigPath} 里显式写了 enabled:false（默认是放行）`
  }

  private requireRuntime(): BusRuntime {
    if (this.runtime === undefined) {
      throw new BusError('E_DISABLED', 'dsh-session-send 尚未装配（mount 未执行）')
    }
    return this.runtime
  }
}

/** Windows 路径大小写不敏感；统一归一后再比。 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

export type { ProjectSwitchState }
