/**
 * registry 工厂：把各来源 provider 装配成 CompositeRegistry。
 * 想换「agent 注册表」= 换这里的 provider 列表或加一个新 provider，其余层不动。
 *
 * 只装配 **DSH 宿主内** 的来源：
 *   · dsh-team  —— AgentTeams(team.json + inbox) 的成员与队长（唯一允许出现 dsh-team 的地方：./dsh-team-adapter.ts）
 *   · dsh-sessions —— 当前 DSH 进程内活着的 session/agent（ctx.agents.list()）
 */
import type { BusConfig } from '../types.ts'
import { CompositeRegistry, type Registry, type RegistryProvider } from './registry.ts'
import { DshTeamAdapter, type CompatTarget } from './dsh-team-adapter.ts'
import { DshSessionsProvider } from './dsh-sessions.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 找出所有「独立项目」的根 —— 即目录下存在项目配置文件的那些。
 *
 * 用途：处理嵌套项目。`...\SOP\loop` 在 `D:\openclaw-data` 的子树里，
 * 但只要 loop 自己有 `.dsh-bus.json`，它就是一个独立项目，
 * openclaw-data 不该把它的会话算成自己的。
 *
 * 来源：宿主 workspaceRegistry 里的 workspace 列表（只取真实存在配置文件的）。
 * 拿不到 registry 时返回空数组，退化为「子树内都算」的旧行为。
 */
export function discoverProjectRoots(ctx: any, configName: string): string[] {
  const roots = new Set<string>()
  try {
    const registry = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry
    const list: any[] = registry?.list?.() ?? []
    for (const workspace of list) {
      const path = workspace?.path
      if (typeof path !== 'string' || path.trim() === '') continue
      if (existsSync(join(path, configName))) roots.add(path)
    }
  } catch {
    /* 没有 workspaceRegistry：返回空 */
  }
  return [...roots]
}

export interface CreateRegistryOptions {
  config: BusConfig
  /** 项目根（workspace 路径）—— dsh-team 状态目录相对它解析。 */
  projectRoot: string
  ctx?: any
  logger?: { info?(message: string): void; warn?(message: string): void }
  /** 测试注入：完全替换 provider 列表。 */
  providers?: RegistryProvider[]
  /** 测试注入：覆盖 dsh-team 包目录。 */
  dshTeamPackageDir?: string
  /**
   * 已知的其它独立项目根（含本项目）。
   * 用于嵌套项目归属判定 —— 见 discoverProjectRoots 的说明。
   */
  knownProjectRoots?: readonly string[]
}

export interface RegistryBundle {
  registry: Registry
  dshTeam: DshTeamAdapter | undefined
}

export function createRegistry(options: CreateRegistryOptions): RegistryBundle {
  if (options.providers !== undefined) {
    return { registry: new CompositeRegistry(options.providers), dshTeam: undefined }
  }
  const { config, projectRoot } = options
  const providers: RegistryProvider[] = []
  let dshTeam: DshTeamAdapter | undefined

  for (const source of config.registry.sources) {
    switch (source) {
      case 'dsh-team':
        if (!config.router.dshTeam.enabled) break
        dshTeam = new DshTeamAdapter({
          projectRoot,
          stateDir: config.registry.stateDir,
          target: config.router.dshTeam.target as CompatTarget,
          packageDir: options.dshTeamPackageDir,
          ctx: options.ctx,
          logger: options.logger,
        })
        providers.push(dshTeam)
        break
      case 'dsh-sessions':
        providers.push(
          new DshSessionsProvider({
            ctx: options.ctx,
            projectRoot,
            // 已知的独立项目根（含本项目）：用于判定嵌套项目的归属
            knownProjectRoots: [
              ...(options.knownProjectRoots ?? []),
              projectRoot,
            ],
            // 使用者配置的会话显示名（解决"121 个会话全叫 session-"）
            labels: config.labels,
            // 是否要求报名后才参与（默认 true：不打扰无关会话）
            requireRegistration: config.registry.requireRegistration,
            // 不传 names：provider 每次从 <项目>/.dsh-bus/names.json 读，
            // 这样会话自注册后立刻生效，不需要重装配。
            logger: options.logger,
          }),
        )
        break
      default:
        // 未知来源（例如旧配置里的 openclaw-sessions）直接跳过，不装配、不报错。
        options.logger?.warn?.(`[dsh-session-send] 忽略未知注册表来源：${String(source)}`)
        break
    }
  }

  return { registry: new CompositeRegistry(providers), dshTeam }
}

export type { Registry, RegistryProvider, AgentEntry } from './registry.ts'
export { CompositeRegistry, normalizeRef } from './registry.ts'
export { DshTeamAdapter } from './dsh-team-adapter.ts'
