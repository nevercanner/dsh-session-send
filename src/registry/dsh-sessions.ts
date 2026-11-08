/**
 * dsh-sessions provider —— 暴露 DSH 的会话作为可寻址条目。
 *
 * ── 关键区分（真实痛点）──────────────────────────────────────────
 * 宿主有两个层次：
 *
 *   · **活 Agent**：`ctx.agents.list()` —— 本进程内已载入内存的会话。
 *     只有这些能被 `steer/followup` 立即唤醒。
 *   · **持久化会话**：`ctx.sessionQuery.listSessions()` —— 磁盘上的记录（含 live 标记）。
 *     重启后没被访问过的会话只是记录，**不是活 Agent**。
 *
 * 只列活 Agent 会造成一个很实际的问题：
 * 用户在 UI 里看着 7 个会话「都打开着」，但重启后只有 1 个真的被激活；
 * 其余 6 个在注册表里查不到，发消息直接 `E_TARGET_NOT_FOUND` ——
 * 用户会以为插件坏了。
 *
 * 所以这里**两层都列**，用 `status` 区分：
 *   `live`     —— 已激活，可立即唤醒
 *   `inactive` —— 有记录但未激活，需要先冷启动（见 transport/session-push.ts 的 resume 分支）
 */
import type { AgentEntry, RegistrySource } from '../types.ts'
import type { RegistryProvider } from '../registry/registry.ts'
import { resolveService } from '../service-access.ts'
import { nameOf, readNames, type NameRegistry } from './names.ts'

/**
 * `child` 是否等于 `parent` 或在其子树内（路径比较，大小写不敏感 —— Windows）。
 *
 * 用分隔符边界判断，避免 `D:\foo` 误匹配 `D:\foobar`。
 */
export function isWithin(parent: string, child: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const p = normalize(parent)
  const c = normalize(child)
  if (p === '') return false
  if (c === p) return true
  return c.startsWith(`${p}/`)
}

/**
 * 在候选项目根里，找出**最具体**地包含 `child` 的那个（最长路径匹配）。
 *
 * 为什么需要「最具体」而不是「第一个包含」：
 * 项目可以嵌套 —— 例如 `D:\openclaw-data\agents\shared\SOP\loop` 在
 * `D:\openclaw-data` 的子树里，但用户把它们当**两个独立项目**。
 * 如果只判「是否在子树内」，loop 的会话会同时属于两者，永远归给外层。
 *
 * 所以：取路径最长的那个匹配项。loop 一旦自己建了 `.dsh-bus.json`，
 * 它的会话就归 loop，不再归 openclaw-data。
 *
 * @returns 匹配到的项目根；没有任何候选包含它时返回 undefined
 */
export function nearestProjectRoot(candidates: readonly string[], child: string): string | undefined {
  let best: string | undefined
  for (const candidate of candidates) {
    if (!isWithin(candidate, child)) continue
    if (best === undefined) {
      best = candidate
      continue
    }
    // 取更长的那个（更具体）
    const normalizedBest = best.replace(/\\/g, '/').replace(/\/+$/, '').length
    const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/\/+$/, '').length
    if (normalizedCandidate > normalizedBest) best = candidate
  }
  return best
}

export interface DshSessionsProviderOptions {
  /** 宿主 ctx（取 agents / sessionQuery）。 */
  ctx: any
  /**
   * 项目根（workspace 路径）。
   *
   * **硬边界**：只列属于这个项目的会话。
   * 插件虽然装配在 profile 层（全局），但「谁能看见谁」必须按项目隔离 ——
   * 否则在 A 项目里能看到 B 项目所有会话的 id 与标题，既越权又制造
   * 「看得到却发不出去」的假目标。
   */
  projectRoot: string
  /**
   * 其它**独立项目**的根（可选）。
   *
   * 用于处理嵌套项目：`...\SOP\loop` 在 `D:\openclaw-data` 的子树里，
   * 但用户把它们当两个独立项目。判定归属时取**最具体**的匹配项 ——
   * 所以需要知道有哪些更具体的项目根存在。
   *
   * 不传时退化为「子树内都算本项目」。
   */
  knownProjectRoots?: readonly string[]
  /**
   * 会话显示名映射：session id → 可读名。
   * 来自项目配置的 `labels`，优先级高于宿主标题与兜底名。
   */
  labels?: Readonly<Record<string, string>>
  /**
   * 自注册名册（会话自己调 dsh_bus_register 报的名）。
   *
   * 传 `undefined` 时 provider 会**每次从项目文件读**（见 `currentNames`），
   * 这样报名后立刻生效，不需要重装配。显式传入则用于测试。
   */
  names?: Readonly<NameRegistry>
  logger?: { warn?(message: string): void }
}

/** sessionQuery 返回的会话记录的最小形状。 */
interface SessionRecord {
  header?: { id?: string; cwd?: string; title?: string; createdAt?: number }
  live?: boolean
  persisted?: boolean
  id?: string
  cwd?: string
  title?: string
  createdAt?: number
}

export class DshSessionsProvider implements RegistryProvider {
  readonly source: RegistrySource = 'dsh-sessions'
  private readonly options: DshSessionsProviderOptions
  /** resolve 期间建立的 id → 宿主 title 映射（仅用于判断 title 可否寻址）。 */
  private titleById = new Map<string, string>()

  constructor(options: DshSessionsProviderOptions) {
    this.options = options
  }

  async available(): Promise<boolean> {
    const agents = resolveService<{ list?: () => unknown }>(this.options.ctx, 'agents')
    return typeof agents?.list === 'function'
  }

  /**
   * 列出**本项目**的可寻址会话：活 Agent 优先，再补上磁盘上有记录但未激活的。
   *
   * 顺序有意义：同 id 时活 Agent 的条目胜出（它带更准的 status）。
   * 跨项目的会话一律过滤掉（见 `belongsToProject`）。
   */
  async list(): Promise<AgentEntry[]> {
    const seen = new Set<string>()
    const entries: AgentEntry[] = []
    // 名册只读一次（本次列表共用），避免每个会话各读一遍文件
    const names = await this.currentNames()

    // ① 活 Agent（可立即唤醒）
    for (const agent of this.liveAgents()) {
      const entry = this.toEntry(agent, names)
      if (entry.id === '' || seen.has(entry.id)) continue
      if (!this.belongsToProject(entry.workspace)) continue
      seen.add(entry.id)
      entries.push(entry)
    }

    // ② 磁盘记录（未激活的补进来）
    for (const record of await this.persistedSessions()) {
      const entry = this.toEntryFromRecord(record, names)
      if (entry === undefined || entry.id === '' || seen.has(entry.id)) continue
      if (!this.belongsToProject(entry.workspace)) continue
      seen.add(entry.id)
      entries.push(entry)
    }

    return entries
  }

  /**
   * 会话是否属于本项目。
   *
   * 判定规则（**支持嵌套项目**）：
   *   在所有「已存在的独立项目根」里找最具体地包含该会话 cwd 的那个；
   *   只有它等于本项目根时才算属于本项目。
   *
   * 举例：会话在 `...\SOP\loop` 下
   *   · loop 自己建了 .dsh-bus.json → 归 loop（最具体），openclaw-data 看不到
   *   · loop 没建 → 归 openclaw-data（退回到外层项目）
   *
   * 会话记录缺 cwd 时**排除**（宁可少列，不可越界）。
   */
  private belongsToProject(workspace: string | undefined): boolean {
    if (typeof workspace !== 'string' || workspace.trim() === '') return false
    const candidates = this.projectCandidates()
    if (candidates.length <= 1) {
      // 只有自己一个项目：子树内都算（旧行为，兼容非嵌套场景）
      return isWithin(this.options.projectRoot, workspace)
    }
    const owner = nearestProjectRoot(candidates, workspace)
    if (owner === undefined) return false
    return isWithin(owner, this.options.projectRoot) && isWithin(this.options.projectRoot, owner)
  }

  /** 候选项目根：本项目 + 已知的其它独立项目（都必须是本项目根或本项目自己）。 */
  private projectCandidates(): string[] {
    const roots = new Set<string>()
    roots.add(this.options.projectRoot)
    for (const root of this.options.knownProjectRoots ?? []) {
      if (typeof root === 'string' && root.trim() !== '') roots.add(root)
    }
    return [...roots]
  }

  /**
   * 解析一个 `to` 引用到具体会话。
   *
   * ── 哪些引用是**权威**的（可以寻址）──────────────────────────
   *   ① **session id** —— 唯一、稳定、永不变。这是正确的寻址键。
   *   ② **自注册名** —— 会话自己报的名，绑在 id 上，id 不变它就不变。
   *   ③ 配置 `labels` 里的名字 —— 同理，绑在 id 上。
   *   ④ 宿主 title —— 宿主的正式字段，绑在会话上。
   *
   * ── 哪些**不**参与寻址（重要）────────────────────────────────
   *   兜底名（`11-08 15:49 · e9f8dca`）**不可寻址**。
   *   它是「从 id + 创建时间派生出来的显示字符串」，不是身份：
   *     · 拿它当键，等于让一个派生值冒充身份；
   *     · 使用者会误以为「名字」可以随手写，掩盖了「应该用 id 或自注册」这件事；
   *     · 显示名将来若调整格式，旧引用全部失效。
   *   所以它只用于**人看**，绝不用于寻址。
   */
  async resolve(ref: string): Promise<AgentEntry[]> {
    const hits: AgentEntry[] = []
    const names = await this.currentNames()
    const live = this.liveAgents()
    const persisted = await this.persistedSessions()

    // 先建立「id → 宿主 title」映射，供 boundNames 判断 title 是否可寻址。
    this.titleById = new Map<string, string>()
    for (const agent of live) {
      const id = String(agent?.id ?? '')
      const title = this.titleOf(agent)
      if (id !== '' && title !== undefined) this.titleById.set(id, title)
    }
    for (const record of persisted) {
      const header = this.headerOf(record)
      const id = typeof header.id === 'string' ? header.id : ''
      const title = typeof header.title === 'string' && header.title.trim() !== '' ? header.title : undefined
      if (id !== '' && title !== undefined && !this.titleById.has(id)) this.titleById.set(id, title)
    }

    const matches = (entry: AgentEntry): boolean => {
      if (entry.id === ref) return true
      // 只有「绑定在 id 上的名字」才可作为引用：自注册名 / labels / 宿主 title。
      return this.boundNames(entry.id, names).some((name) => name === ref)
    }

    // 先查活 Agent（最快也最准）—— 同样受项目边界约束
    for (const agent of live) {
      const entry = this.toEntry(agent, names)
      if (!matches(entry)) continue
      if (!this.belongsToProject(entry.workspace)) continue
      hits.push(entry)
    }
    if (hits.length > 0) return hits
    // 再查磁盘记录（可能是未激活的会话）
    for (const record of persisted) {
      const entry = this.toEntryFromRecord(record, names)
      if (entry === undefined) continue
      if (!matches(entry)) continue
      if (!this.belongsToProject(entry.workspace)) continue
      hits.push(entry)
    }
    return hits
  }

  /**
   * 一个会话身上**绑定在 id 上**的名字（可用于寻址）。
   * 不含兜底名 —— 那是派生的显示值，不是身份。
   */
  private boundNames(sessionId: string, names: Readonly<NameRegistry>): string[] {
    const out: string[] = []
    const registered = nameOf(names, sessionId)
    if (registered !== undefined) out.push(registered)
    const custom = this.options.labels?.[sessionId]
    if (typeof custom === 'string' && custom.trim() !== '') out.push(custom.trim())
    const title = this.titleById.get(sessionId)
    if (title !== undefined && title.trim() !== '') out.push(title.trim())
    return out
  }

  /** 该会话当前是否已激活（能被立即唤醒）。 */
  isLive(sessionId: string): boolean {
    return this.agentOf(sessionId) !== undefined
  }

  private agentOf(sessionId: string): any {
    try {
      return resolveService<any>(this.options.ctx, 'agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  private liveAgents(): any[] {
    const agents = resolveService<{ list?: () => unknown }>(this.options.ctx, 'agents')
    try {
      const list = agents?.list?.()
      return Array.isArray(list) ? list : []
    } catch (error) {
      this.options.logger?.warn?.(`[dsh-session-send] 读 agents.list() 失败：${String(error)}`)
      return []
    }
  }

  /**
   * 磁盘上的会话记录。
   * sessionQuery 缺席（headless / 精简组合）时返回空数组，不影响活 Agent 那条路。
   */
  private async persistedSessions(): Promise<SessionRecord[]> {
    const query = resolveService<{ listSessions?: (signal?: AbortSignal) => Promise<unknown> }>(
      this.options.ctx,
      'sessionQuery',
    )
    if (typeof query?.listSessions !== 'function') return []
    try {
      const rows = await query.listSessions()
      return Array.isArray(rows) ? (rows as SessionRecord[]) : []
    } catch (error) {
      this.options.logger?.warn?.(`[dsh-session-send] 读 sessionQuery.listSessions() 失败：${String(error)}`)
      return []
    }
  }

  private headerOf(record: SessionRecord): { id?: string; cwd?: string; title?: string; createdAt?: number } {
    return record.header ?? record
  }

  private toEntryFromRecord(record: SessionRecord, names: Readonly<NameRegistry>): AgentEntry | undefined {
    const header = this.headerOf(record)
    const id = typeof header.id === 'string' ? header.id : ''
    if (id === '') return undefined
    const title = typeof header.title === 'string' && header.title.trim() !== '' ? header.title : undefined
    return {
      id,
      // 优先级：自注册名 > labels > 宿主 title > 可区分兜底名
      name: this.displayName(id, title, header.createdAt, names),
      kind: 'session',
      source: this.source,
      workspace: typeof header.cwd === 'string' ? header.cwd : undefined,
      // live 字段是宿主的权威标记；缺席按未激活处理
      status: record.live === true ? 'live' : 'inactive',
    }
  }

  /**
   * 决定一条会话的显示名。优先级：
   *   ① 自注册名（会话自己调 dsh_bus_register 报的）—— 最贴近实际
   *   ② 项目配置里的 `labels[id]` —— 留给「想覆盖某个名字」的场合
   *   ③ 宿主的 title —— 只有 session-title 生成过才有
   *   ④ 兜底：创建时间 + id 尾段 —— 保证可区分
   */
  private displayName(
    id: string,
    title: string | undefined,
    createdAt: number | undefined,
    names: Readonly<NameRegistry>,
  ): string {
    const registered = nameOf(names, id)
    if (registered !== undefined) return registered
    const custom = this.options.labels?.[id]
    if (typeof custom === 'string' && custom.trim() !== '') return custom.trim()
    if (title !== undefined && title.trim() !== '') return title
    return this.fallbackName(id, createdAt)
  }

  /**
   * 当前名册：显式传入的优先，否则每次从项目文件读。
   *
   * 每次读是必要的 —— 会话报名后列表要立刻反映，不能等重装配。
   * 读失败按空名册处理（readNames 内部已兜住）。
   */
  private async currentNames(): Promise<Readonly<NameRegistry>> {
    if (this.options.names !== undefined) return this.options.names
    return readNames(this.options.projectRoot)
  }

  /**
   * 没有标题时的兜底显示名。
   *
   * 真实痛点：121 个会话 `title` 全为空，列表里全是 `session-` / `c883810e`，
   * 使用者没法判断哪个是哪条工作线。
   *
   * 规则很朴素：**创建时间 + id 去掉 `session-` 后的最后 7 位**。
   * 例如 `session-da38f11a-5982-4d2c-bc3d-c5381400cf88` → `11-03 19:58 · 400cf88`。
   *
   * 注意：这不是哈希，也不是「uuid 开头那段」。最后一段是 `c5381400cf88`，
   * 取末 7 位就是 `400cf88`。曾有人误判为「哈希/顺序不对」，这里写明以免再误读。
   *
   * 实测 121 个会话的尾段全部唯一（零碰撞），所以它**足以区分**，
   * 但它仍然只是**给人看的派生值，不能用于寻址** —— 见 resolve() 的说明。
   */
  private fallbackName(id: string, createdAt: number | undefined): string {
    const tail = id.replace(/^session-/, '').slice(-7)
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return tail
    try {
      const d = new Date(createdAt)
      const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      return `${stamp} · ${tail}`
    } catch {
      return tail
    }
  }

  private titleOf(agent: any): string | undefined {
    const header = agent?.session?.header
    const title = header?.title ?? header?.name
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  }

  private cwdOf(agent: any): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : undefined
  }

  private toEntry(agent: any, names: Readonly<NameRegistry>): AgentEntry {
    const id = String(agent?.id ?? '')
    const createdAt = agent?.session?.header?.createdAt
    return {
      id,
      name: this.displayName(
        id,
        this.titleOf(agent),
        typeof createdAt === 'number' ? createdAt : undefined,
        names,
      ),
      kind: 'session',
      source: this.source,
      workspace: this.cwdOf(agent),
      status: 'live',
    }
  }
}
