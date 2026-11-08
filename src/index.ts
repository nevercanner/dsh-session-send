/**
 * openclaw-dsh-bus —— 插件入口（**DSH 宿主侧**）。
 *
 * ── 定位（先读这段）────────────────────────────────────────────
 * 这是一个**DSH 插件**，运行在 DSH 进程里。它参考 OpenClaw 的 `session send`
 * 建立 agent 间通信的**做法**——消息语义、寻址方式、显式失败——
 * 但完全不碰 OpenClaw 的进程、配置与数据面。
 *
 * 具体地说，参考的是：
 *   · 消息形状 `{ from, to, kind, payload, replyTo }`，kind ∈ text|request|response|event
 *   · 寻址：session id / agent id / 广播 "*"
 *   · 目标不存在必须显式报错（绝不静默丢弃）
 *   · 请求-响应靠 replyTo 关联，不靠字符串猜上下文
 * 不参考也不使用：`openclaw.json`、它磁盘上的 session 账本、它的 channel 机制。
 *
 * ── 开关（两把锁，都默认关）─────────────────────────────────────
 *   ① profile patch 的 `enabled`（默认 false）——插件自身允许运行
 *   ② **项目根下的 `.dsh-bus.json`** —— 本项目允许通信
 *
 * ② 不需要手写：侧栏 Session 行的「...」菜单里有一行开关，
 * 点一下写文件并**热生效**（不重启宿主）。状态也由那行直接显示。
 * 见 src/api/control.ts。
 *
 * ── 四层解耦（任何一层可替换）───────────────────────────────────
 *   transport  src/transport/*   只认 Transport 接口（sqlite | file | in-process）
 *   registry   src/registry/*    只认 RegistryProvider 接口（dsh-team | dsh-sessions）
 *   router     src/router/*      只认 Registry + Transport 接口，**不读任何配置文件**
 *   ui         src/ui/*          只通过 /plugins/openclaw-dsh-bus/* HTTP 面
 */
import { assertHostCompatibility, compatibilityReport } from './compat.ts'
import { DEFAULT_PROJECT_CONFIG_NAME, loadProjectConfig } from './config/project-config.ts'
import { createTransport } from './transport/index.ts'
import { SessionPusher } from './transport/session-push.ts'
import { createRegistry, discoverProjectRoots } from './registry/index.ts'
import { createRouter } from './router/index.ts'
import { BusService, type BusRuntime } from './api/service.ts'
import { registerBusRoutes } from './api/routes.ts'
import { registerBusTools } from './api/tools.ts'
import { createProjectControl } from './api/control.ts'
import { resolveService } from './service-access.ts'
import type { BusConfig } from './types.ts'
import { importSchemastery } from './host-modules.ts'

export const name = 'openclaw-dsh-bus'

/** 插件描述（宿主插件列表里展示）。 */
export const description =
  'DSH 会话总线：参考 openclaw session send 的消息语义，让不同 DSH session/agent 互相发消息；' +
  '复用 dsh-team 的 agent 注册与路由。带左侧栏入口、未读标记与消息流。' +
  '项目开关在侧栏 Session 行的「...」菜单里一键切换（写入 .dsh-bus.json 并热生效），不用手写配置文件。'

/** schemastery 版 Config（宿主设置面板 / patch 校验用）；schemastery 解析不到时为 undefined。 */
export const Config = await loadSchemasteryConfig()

/**
 * schemastery 取法：**动态 import + 多路径兜底 + undefined 降级**，绝不静态 import。
 * 静态 import 解析不到会让整个 entry 加载失败（插件管理页直接标「异常」，侧栏入口一起消失）；
 * 降级代价只是「详情页没有配置区」，功能照常。
 */
async function loadSchemasteryConfig(): Promise<any> {
  try {
    const module: any = await importSchemastery()
    if (module === undefined) return undefined
    const z = module?.default ?? module
    return z.object({
      enabled: z.boolean().default(false).description('允许本插件工作（项目开关由侧栏菜单控制）'),
      projectConfigName: z.string().default(DEFAULT_PROJECT_CONFIG_NAME).description('项目级配置文件名（相对 workspace 根）'),
      projectRoot: z.string().description('显式指定项目根；缺省取当前会话的 workspace / cwd'),
      dshTeamPackageDir: z.string().description('显式指定 @nanmicoder/dsh-agent-teams 目录（一般不用填）'),
    })
  } catch {
    return undefined
  }
}

export interface PluginConfig {
  enabled?: boolean
  projectConfigName?: string
  projectRoot?: string
  dshTeamPackageDir?: string
}

/** 插件装配态：卸载时按序回收。 */
let mounted: { service: BusService; disposers: Array<() => void> } | undefined

/** 取项目根：显式配置 > 当前会话 cwd > 进程 cwd。绝不由配置文件自述。 */
function resolveProjectRoot(ctx: any, config: PluginConfig): string {
  if (typeof config.projectRoot === 'string' && config.projectRoot.trim() !== '') return config.projectRoot.trim()
  try {
    const workingDirectory = resolveService<any>(ctx, 'workingDirectory')
    const agent = resolveService<any>(ctx, 'agents')?.currentInitiator?.()
    if (agent !== undefined && typeof workingDirectory?.get === 'function') {
      const dir = workingDirectory.get(agent.session)
      if (typeof dir === 'string' && dir !== '') return dir
    }
  } catch {
    /* 落到下一个候选 */
  }
  try {
    const agent = resolveService<any>(ctx, 'agents')?.list?.()?.[0]
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    /* 落到下一个候选 */
  }
  return process.cwd()
}

export async function apply(ctx: any, config: PluginConfig = {}): Promise<void> {
  // ── 0. fail-fast：版本不满足直接抛，绝不半坏着跑 ──
  const hostVersion: string | undefined =
    resolveService<any>(ctx, 'runtime')?.version ?? process.env['DSH_VERSION'] ?? undefined
  assertHostCompatibility(hostVersion, ctx?.logger)

  const logger = {
    info: (message: string) => ctx?.logger?.info?.(message),
    warn: (message: string) => ctx?.logger?.warn?.(message),
  }
  const configName = config.projectConfigName ?? DEFAULT_PROJECT_CONFIG_NAME

  /**
   * runtime 工厂：按任意项目根构建一套四层实例。
   * 热切换（UI 点开关）与首次装配走**同一条**路径，保证两种入口行为一致。
   */
  const buildRuntime = async (projectRoot: string): Promise<BusRuntime> => {
    const loaded = await loadProjectConfig({
      projectRoot,
      configName,
      baseConfig: { enabled: config.enabled === true } as Partial<BusConfig>,
      logger,
    })
    const busConfig: BusConfig = loaded.value
    const transport = createTransport({ config: busConfig, projectRoot })
    // 找出所有独立项目的根（含嵌套的），用于正确判定会话归属：
    // 例如 loop 一旦自己建了 .dsh-bus.json，它的会话就归 loop 而不是外层 openclaw-data。
    const knownProjectRoots = discoverProjectRoots(ctx, configName)
    const { registry, dshTeam } = createRegistry({
      config: busConfig,
      projectRoot,
      ctx,
      logger,
      dshTeamPackageDir: config.dshTeamPackageDir,
      knownProjectRoots,
    })
    // 跨会话投递器：把消息真正推进目标的活会话（这是「不用人工转发」的关键）
    const sessions = new SessionPusher({ ctx, logger })
    const router = createRouter({ config: busConfig, transport, registry, dshTeam, sessions, logger })
    return {
      config: busConfig,
      projectRoot,
      projectConfigPath: loaded.projectConfigPath,
      transport,
      registry,
      router,
      dshTeam,
      warnings: loaded.warnings,
      configPresent: loaded.present,
      configDegraded: loaded.degraded,
    }
  }

  const projectRoot = resolveProjectRoot(ctx, config)

  /**
   * 解析「这次调用属于哪个项目」。
   *
   * 优先级：显式配置 > 调用者会话的 cwd > 当前 initiator 的 cwd > 进程 cwd。
   *
   * **为什么必须每次调用都解析**：宿主长期运行，同一进程里有多个 workspace 的会话。
   * 谁在启动瞬间触发装配，不该决定之后所有调用用哪个项目的配置 ——
   * 那会导致「A 项目里开的会话，去发消息却读 B 项目的开关」。
   */
  const resolveCallerProject = (exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } }): string | undefined => {
    if (typeof config.projectRoot === 'string' && config.projectRoot.trim() !== '') return config.projectRoot.trim()
    // ① 调用者自己的会话 cwd（最准）
    const callerCwd = exec?.agent?.session?.header?.cwd
    if (typeof callerCwd === 'string' && callerCwd.trim() !== '') return callerCwd.trim()
    // ② 调用者 id 查活 Agent 拿 cwd
    const callerId = exec?.agent?.id
    if (typeof callerId === 'string' && callerId !== '') {
      try {
        const agent = resolveService<any>(ctx, 'agents')?.get?.(callerId)
        const cwd = agent?.session?.header?.cwd
        if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
      } catch {
        /* 继续 */
      }
    }
    // ③ 当前 initiator
    try {
      const agent = resolveService<any>(ctx, 'agents')?.currentInitiator?.()
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
    } catch {
      /* 继续 */
    }
    return undefined
  }

  /**
   * 只读探测：只读配置，绝不装配。
   * 与 buildRuntime 分开是必要的 —— 装配会建 transport（sqlite 会建目录与库文件），
   * 「看一眼状态」不该在别人的项目里留下任何东西。
   */
  const probeRuntime = async (root: string): Promise<import('./api/service.ts').ProjectSwitchState> => {
    const loaded = await loadProjectConfig({ projectRoot: root, configName, logger })
    return {
      projectRoot: root,
      projectConfigPath: loaded.projectConfigPath,
      present: loaded.present,
      enabled: loaded.value.enabled,
      reason: loaded.value.enabled
        ? undefined
        : loaded.degraded
          ? '项目配置解析失败，已强制关闭'
          : loaded.present
            ? '项目配置里 enabled 不是 true'
            : `本项目未启用：${loaded.projectConfigPath} 不存在`,
      error: loaded.degraded ? '配置文件解析失败' : undefined,
    }
  }

  const service = new BusService({
    factory: buildRuntime,
    probe: probeRuntime,
    resolveProject: resolveCallerProject,
    logger,
  })
  const disposers: Array<() => void> = []

  // ── 1. 首次装配 ──
  let initial: BusRuntime
  try {
    initial = await buildRuntime(projectRoot)
    await service.mount(initial)
  } catch (error) {
    // 装配失败不该拖垮宿主：记录并保持「未装配」状态，UI 上显示原因。
    logger.warn(`[openclaw-dsh-bus] 装配失败：${String(error)}`)
    return
  }

  mounted = { service, disposers }

  logger.info(
    `[openclaw-dsh-bus] 项目 ${projectRoot}：` +
      (initial.config.enabled
        ? `已启用（transport=${initial.config.transport.kind}）`
        : `未启用（${initial.configPresent ? `${configName} 里 enabled 不是 true` : `${configName} 不存在`}）——可在侧栏 Session 行「...」菜单里一键开启`),
  )

  // ── 2. 项目开关写入口（唯一写文件的地方）──
  const control = createProjectControl({
    configName,
    // 读状态：只读探测（当前项目走运行时真值，其它项目只读配置，都不建连接）
    readState: (root: string) => service.projectState(root),
    // 变更后热装配
    reconfigure: async (root: string) => {
      await service.reconfigure(root)
      return service.projectState(root)
    },
    logger,
  })

  // ── 3. HTTP 面（侧栏 UI 用）──懒等 webServer 到位（headless profile 里没有它） ──
  ctx.inject?.(['webServer'], () => {
    const routes = registerBusRoutes({ bus: service, control, ctx, logger })
    for (const entry of routes) {
      if (typeof entry.dispose === 'function') disposers.push(entry.dispose)
    }
    ctx.effect?.(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 卸载不应抛出 */
        }
      }
    }, 'openclaw-dsh-bus: routes')
  })

  // ── 4. 模型侧工具 ──
  ctx.inject?.(['tools'], (toolCtx: any) => {
    const tools = toolCtx?.tools
    if (tools === undefined) {
      logger.warn('[openclaw-dsh-bus] tools 服务未就位，模型侧工具不注册')
      return
    }
    const toolDisposers = registerBusTools({ bus: service, tools, logger })
    disposers.push(...toolDisposers)
    ctx.effect?.(() => () => {
      for (const dispose of toolDisposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }, 'openclaw-dsh-bus: tools')
  })

  // ── 5. 只读诊断命令：在 Web GUI 斜杠菜单里能看到当前状态与「为什么没开」──
  ctx.inject?.(['commands'], (commandCtx: any) => {
    try {
      const off = commandCtx.commands.register({
        name: 'dsh-bus',
        description: 'Show openclaw-dsh-bus status: project switch, transport, registry sources, adapter mode.',
        async execute() {
          const status = await service.statusAsync()
          const compat = compatibilityReport(hostVersion)
          const hint = status['disabledReason']
            ? `\n\n未启用。在侧栏 Session 行的「...」菜单里点「会话总线：开启」即可，` +
              `它会写入 ${String(status['projectConfigPath'])} 并立即生效。`
            : ''
          return [
            {
              type: 'text',
              text: `openclaw-dsh-bus 状态\n${JSON.stringify(status, null, 2)}\n\n兼容性\n${JSON.stringify(compat, null, 2)}${hint}`,
            },
          ]
        },
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      logger.warn(`[openclaw-dsh-bus] 注册 /dsh-bus 命令失败：${String(error)}`)
    }
  })

  // ── 6. 卸载时回收 ──
  ctx.effect?.(() => () => {
    void service.unmount()
    mounted = undefined
  }, 'openclaw-dsh-bus: lifetime')
}

/** 供测试与诊断使用（宿主不会调用）。 */
export function internals(): { mounted: typeof mounted } {
  return { mounted }
}

export type { BusConfig, BusMessage, SendRequest, SendReceipt } from './types.ts'
