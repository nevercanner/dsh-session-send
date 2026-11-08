/**
 * dsh-team（AgentTeams）adapter —— **本插件里唯一允许出现 dsh-team 的地方**。
 *
 * 集成的原则：**只包装，不 fork、不复制、不改它的注册逻辑**。
 * 这里做三件事：
 *   1. 把 dsh-team 的 team.json / inbox 状态读成我们的 AgentEntry（注册表视角）；
 *   2. 把投递动作翻译成它真实暴露的函数（`deliverToMember` / `steerCaptainReport` /
 *      `appendMailbox`）—— 这些都是 dsh-team 自己 `lib/` 里的导出，我们不重新实现；
 *   3. 对版本差异做**分支兼容**（见下面 `CompatMode`），差异全部收在这个文件内。
 *
 * ── 调研记录（2026-11，实测而非猜测）──────────────────────────────────
 * 目标插件：`@nanmicoder/dsh-agent-teams`
 *   profile 内路径：~/.dsh/profiles/<profile>/node_modules/@nanmicoder/dsh-agent-teams
 *   它的 lib 实际导出：
 *     state.js  : readTeam / readTeamSync / findTeamByParticipant / findTeamByCaptain /
 *                 createMessage / appendMailbox / readMailbox / readUnreadMailbox /
 *                 withTeamLock / CAPTAIN_KEY
 *     mailbox.js: mailboxPrompt(teamId, recipient, messages)
 *     members.js: deliverToMember(ctx, captain, childId, text, signal, mode) /
 *                 steerCaptainReport(captain, from, content, text)
 *     lineage.js: nearestLiveLead(ctx, team)
 *   磁盘真相：`<workspace>/.agent-teams/<teamId>/team.json`，邮箱是
 *     `<workspace>/.agent-teams/<teamId>/inbox/<agentKey>.jsonl`，一条一行
 *     `{ id, from, to, content, ts, … }`。
 *   它的 `agent_teams_send_message` 工具语义（我们要对齐的）：
 *     to = "captain" 或成员名；`delivered` ∈ live | wake | mailbox | duplicate。
 *
 * ── 兼容分支 ─────────────────────────────────────────────────────────
 * A. `service` 模式：宿主里存在官方 `ctx.agentTeams` 服务（dsh 自带的
 *    `@deepseek-ai/dsh-experimental-agent-team`）时，优先用它 ——
 *    `tryMembership(agent)` / `listMembers(agent)` / `sendMessage(caller, {target, content, signal})`。
 * B. `mailbox` 模式：直接调 dsh-team 的 `deliverToMember` / `steerCaptainReport`。
 * C. `fs-only` 模式：只把消息追加进它的 inbox JSONL（用它的 `appendMailbox`），
 *    不唤醒任何人 —— 当 dsh-team 版本变了、函数签名对不上时自动落到这里，
 *    保证「消息不丢」，并把它标记为 delivered=durable/mailbox。
 *
 * 三种模式都走同一个 `AdapterDelivery` 返回结构，上层 router 不需要知道用了哪种。
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BusError, type AgentEntry, type RegistrySource } from '../types.ts'
import type { RegistryProvider } from './registry.ts'
import { resolveService } from '../service-access.ts'

export type CompatMode = 'service' | 'mailbox' | 'fs-only'
export type CompatTarget = 'auto' | 'service' | 'mailbox'

export interface AdapterDelivery {
  ok: boolean
  /** durable = 只落到 inbox 文件；woken = 已唤醒成员；steered = 已注入活动 lead；queued = 已入队。 */
  mode: 'durable' | 'woken' | 'steered' | 'queued' | 'failed'
  detail?: string
  /** 若走的是 dsh-team 的 mailbox，这里回它的 message id。 */
  messageId?: string
}

export interface DshTeamAdapterOptions {
  /** 项目根（team 状态在 <root>/<stateDir> 还是 <workspace>/<stateDir>，两种都试）。 */
  projectRoot: string
  /** dsh-team 的状态目录名，默认 '.agent-teams'。 */
  stateDir: string
  /** 强制模式；auto = 按可用性 A→B→C 降级。 */
  target?: CompatTarget
  /** 显式指定 @nanmicoder/dsh-agent-teams 的目录（不填则自动解析）。 */
  packageDir?: string
  /** 宿主 ctx（取 agents / logger / subagents；缺席也不影响 fs-only 模式）。 */
  ctx?: any
  logger?: { info?(message: string): void; warn?(message: string): void }
}

/** dsh-team 的团队记录里我们要用的最小字段集。 */
interface TeamRecord {
  id: string
  name?: string
  captainSessionId?: string
  members: Array<{ id: string; name: string; status?: string; role?: string }>
  halted?: boolean
  workspace?: string
}

export class DshTeamAdapter implements RegistryProvider {
  readonly source: RegistrySource = 'dsh-team'
  private readonly options: DshTeamAdapterOptions
  private mods: { state?: any; mailbox?: any; members?: any; lineage?: any } = {}
  private loaded = false
  private resolvedDir: string | undefined
  /** 实际生效的本地模式（service 模式是运行期按调用方判定的，不在这里固化）。 */
  private localMode: CompatMode = 'fs-only'
  private lastError: string | undefined

  constructor(options: DshTeamAdapterOptions) {
    this.options = options
  }

  /**
   * 诊断信息：UI 上直接显示「用的哪种模式、包在哪」。
   *
   * 注意这是**同步**方法，不能 await ensureLoaded()。首次调用时模块还没加载，
   * `localMode` 仍是初始值 `fs-only` —— 那会把「其实能用 mailbox」误报成「只能写文件」。
   * 所以这里如实标注 `resolved: false`，调用方看到未解析就知道要再看一次
   * （`status()` 里会在装配后调用，那时已经加载过）。
   */
  diagnostics(): { mode: CompatMode | 'service'; resolved: boolean; packageDir?: string; error?: string } {
    const serviceAvailable = this.serviceAvailable()
    return {
      mode: serviceAvailable && this.options.target !== 'mailbox' ? 'service' : this.localMode,
      resolved: this.resolvedDir !== undefined,
      packageDir: this.resolvedDir,
      error: this.lastError,
    }
  }

  /** 异步版诊断：先确保模块已加载，再报告真实模式（UI/工具优先用这个）。 */
  async diagnosticsAsync(): Promise<{ mode: CompatMode | 'service'; resolved: boolean; packageDir?: string; error?: string }> {
    if (!this.serviceAvailable() || this.options.target === 'mailbox') {
      await this.ensureLoaded()
    }
    return this.diagnostics()
  }

  async available(): Promise<boolean> {
    if (this.serviceAvailable()) return true
    await this.ensureLoaded()
    return this.resolvedDir !== undefined
  }

  /** 列出所有 team 成员（含队长）作为可寻址条目。 */
  async list(): Promise<AgentEntry[]> {
    // 先确保模块加载：这样紧随其后的 diagnostics() 才能报告真实模式，
    // 而不是初始值 fs-only（否则 UI 会把「能用 mailbox」误显示成「只能写文件」）。
    await this.ensureLoaded()
    const teams = await this.readTeams()
    const entries: AgentEntry[] = []
    for (const team of teams) {
      for (const member of team.members) {
        entries.push({
          id: member.id,
          name: member.name,
          kind: 'agent',
          source: this.source,
          status: member.status,
          teamId: team.id,
          role: member.role === 'lead' ? 'lead' : 'teammate',
          workspace: team.workspace,
        })
      }
    }
    return entries
  }

  async resolve(ref: string): Promise<AgentEntry[]> {
    await this.ensureLoaded()
    const teams = await this.readTeams()
    const hits: AgentEntry[] = []
    for (const team of teams) {
      for (const member of team.members) {
        // 三种写法都算命中：session id / 成员名 / `teamId:成员名`
        if (member.id === ref || member.name === ref || `${team.id}:${member.name}` === ref) {
          hits.push({
            id: member.id,
            name: member.name,
            kind: 'agent',
            source: this.source,
            status: member.status,
            teamId: team.id,
            role: member.role === 'lead' ? 'lead' : 'teammate',
            workspace: team.workspace,
          })
        }
      }
    }
    return hits
  }

  /**
   * 投递一条消息给 dsh-team 的某个成员 / captain。
   *
   * @param target 解析后的条目（可能是 captain）
   * @param from   发送方显示名（同 team 内用成员名，跨来源用 agent id）
   * @param content 纯文本内容
   * @param signal 取消信号（宿主 tool 调用自带的）
   */
  async deliver(
    target: AgentEntry,
    from: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<AdapterDelivery> {
    // ── A. 官方 service 模式 ──
    if (this.serviceAvailable() && this.options.target !== 'mailbox') {
      const attempted = await this.deliverViaService(target, content, signal)
      if (attempted !== undefined) return attempted
      // service 走了但失败/不可用：继续往 B/C 降级，不把消息丢掉。
    }

    await this.ensureLoaded()
    if (this.resolvedDir === undefined) {
      return { ok: false, mode: 'failed', detail: this.lastError ?? 'dsh-team 插件未安装或无法解析' }
    }
    const team = (await this.readTeams()).find((candidate) => candidate.id === target.teamId)
    if (team === undefined) {
      return { ok: false, mode: 'failed', detail: `dsh-team 里找不到团队 ${target.teamId ?? '(未知)'}` }
    }
    const recipientName = this.isCaptain(team, target) ? 'captain' : (target.name ?? target.id)

    // ── B. mailbox 模式：直接用它自己的投递函数 ──
    if (this.localMode === 'mailbox') {
      const live = this.liveAgent(target.id)
      const mailbox = this.mods.mailbox
      try {
        if (mailbox?.mailboxPrompt !== undefined && this.mods.members !== undefined) {
          // 先把消息写进它自己的 inbox（它的 appendMailbox 会做 JSONL 与原子写）
          const created = await this.appendToInbox(team, recipientName, from, content)
          const promptText = mailbox.mailboxPrompt(team.id, recipientName, [created])
          if (recipientName === 'captain') {
            const captain = this.nearestLead(team)
            if (captain !== undefined && typeof this.mods.members.steerCaptainReport === 'function') {
              const steered = this.mods.members.steerCaptainReport(captain, from, content, promptText)
              return { ok: true, mode: steered === true ? 'steered' : 'durable', messageId: created?.id }
            }
            return { ok: true, mode: 'durable', detail: 'captain 不在线，消息留在它的 inbox', messageId: created?.id }
          }
          if (live !== undefined && typeof this.mods.members.deliverToMember === 'function') {
            const captain = this.nearestLead(team)
            if (captain !== undefined) {
              const delivered = await this.mods.members.deliverToMember(
                this.options.ctx,
                captain,
                target.id,
                promptText,
                signal,
                'steer',
              )
              if (delivered === true) return { ok: true, mode: 'woken', messageId: created?.id }
            }
          }
          return { ok: true, mode: 'queued', detail: '成员不在线，消息留在 inbox 等它下次唤醒', messageId: created?.id }
        }
      } catch (error) {
        // 它的函数签名变了（版本漂移）：降级到 fs-only，保证消息不丢。
        this.lastError = `mailbox 模式调用失败，已降级 fs-only：${String(error)}`
        this.options.logger?.warn?.(`[openclaw-dsh-bus] ${this.lastError}`)
      }
    }

    // ── C. fs-only 模式：只写它的 inbox ──
    try {
      const created = await this.appendToInbox(team, recipientName, from, content)
      return { ok: true, mode: 'durable', detail: '仅落入 dsh-team inbox（不唤醒）', messageId: created?.id }
    } catch (error) {
      return { ok: false, mode: 'failed', detail: `写 dsh-team inbox 失败：${String(error)}` }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 内部实现
  // ──────────────────────────────────────────────────────────────

  private serviceAvailable(): boolean {
    return resolveService(this.options.ctx, 'agentTeams') !== undefined
  }

  /** 走官方 ctx.agentTeams 服务；返回 undefined 表示「这个目标不该由 service 处理」。 */
  private async deliverViaService(
    target: AgentEntry,
    content: string,
    signal?: AbortSignal,
  ): Promise<AdapterDelivery | undefined> {
    const service = resolveService(this.options.ctx, 'agentTeams')
    if (service === undefined) return undefined
    // service 的 sendMessage(caller, request) 需要一个活的 caller Agent，且只能发给同 team 的成员。
    const agents = resolveService<any>(this.options.ctx, 'agents')
    const sender = agents?.currentInitiator?.()
    if (sender === undefined) {
      // 没有发起方 Agent（例如 UI 点按钮触发）：service 模式不可用，交给 mailbox/fs-only。
      return undefined
    }
    try {
      const membership = service.tryMembership?.(sender)
      if (membership === undefined) return undefined
      const created = await service.sendMessage(sender, {
        target: target.name ?? target.id,
        content: [{ type: 'text', text: content }],
        signal: signal ?? new AbortController().signal,
      })
      return { ok: true, mode: 'queued', messageId: String(created?.messageId ?? '') || undefined, detail: 'official agentTeams service' }
    } catch (error) {
      this.lastError = `official agentTeams service 投递失败，降级到 dsh-team mailbox：${String(error)}`
      this.options.logger?.warn?.(`[openclaw-dsh-bus] ${this.lastError}`)
      return undefined
    }
  }

  private liveAgent(sessionId: string): any {
    try {
      return resolveService<any>(this.options.ctx, 'agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  private nearestLead(_team: TeamRecord): any {
    try {
      const agents: any[] = resolveService<any>(this.options.ctx, 'agents')?.list?.() ?? []
      return agents[0]
    } catch {
      return undefined
    }
  }

  private isCaptain(team: TeamRecord, target: AgentEntry): boolean {
    return team.captainSessionId === target.id || target.role === 'lead'
  }

  /** 用 dsh-team 自己的 appendMailbox 写 inbox（它负责 JSONL 格式与原子写）。 */
  private async appendToInbox(
    team: TeamRecord,
    recipient: string,
    from: string,
    content: string,
  ): Promise<{ id?: string; from: string; to: string; content: string; ts: number } | undefined> {
    const state = this.mods.state
    const root = this.stateRootFor(team)
    if (root === undefined) throw new BusError('E_TRANSPORT', '无法定位 dsh-team 的状态根目录')
    if (typeof state?.appendMailbox === 'function') {
      const message =
        typeof state.createMessage === 'function'
          ? state.createMessage(from, recipient, content)
          : { id: randomId(), from, to: recipient, content, ts: Date.now() }
      await state.appendMailbox(root, team.id, recipient, message)
      return message
    }
    // 连 appendMailbox 都没有（极端版本漂移）：按它已知的 JSONL 布局自己写一行。
    // 这个分支只为了保证「消息不丢」，格式与 dsh-team 的 mailbox 布局逐字一致。
    const { mkdir, appendFile, readFile: read } = await import('node:fs/promises')
    const dir = join(root, team.id, 'inbox')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${recipient.replace(/[^A-Za-z0-9._@-]/g, '_')}.jsonl`)
    const message = { id: randomId(), from, to: recipient, content, ts: Date.now() }
    let existing = ''
    try {
      existing = await read(file, 'utf8')
    } catch {
      existing = ''
    }
    const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
    await appendFile(file, `${existing}${separator}${JSON.stringify(message)}\n`, 'utf8')
    return message
  }

  /** 每个 team 的状态根：优先 <projectRoot>/<stateDir>，其次 team.workspace/<stateDir>。 */
  private stateRootFor(team: TeamRecord): string | undefined {
    const candidates = [
      join(this.options.projectRoot, this.options.stateDir),
      team.workspace === undefined ? undefined : join(team.workspace, this.options.stateDir),
    ].filter((value): value is string => value !== undefined)
    for (const candidate of candidates) {
      if (existsSync(join(candidate, team.id, 'team.json'))) return candidate
    }
    return candidates[0]
  }

  /** 扫描所有 team.json。读不出来（损坏/权限）就跳过，绝不因此让注册表整个失败。 */
  private async readTeams(): Promise<TeamRecord[]> {
    const roots = await this.candidateStateRoots()
    const teams: TeamRecord[] = []
    for (const root of roots) {
      let dirs: string[] = []
      try {
        dirs = await readdir(root)
      } catch {
        continue
      }
      for (const dir of dirs) {
        if (dir === 'archive') continue
        const team = await this.readTeamFile(join(root, dir, 'team.json'))
        if (team !== undefined) {
          team.workspace ??= dirOfRoot(root)
          teams.push(team)
        }
      }
    }
    return teams
  }

  private async readTeamFile(file: string): Promise<TeamRecord | undefined> {
    try {
      const raw = await readFile(file, 'utf8')
      const value = JSON.parse(raw.replace(/^\uFEFF/, '')) as any
      const members = Array.isArray(value?.members) ? value.members : []
      return {
        id: String(value?.id ?? ''),
        name: typeof value?.name === 'string' ? value.name : undefined,
        captainSessionId: typeof value?.captainSessionId === 'string' ? value.captainSessionId : undefined,
        members: members
          .filter((member: any) => typeof member?.id === 'string' && typeof member?.name === 'string')
          .map((member: any) => ({
            id: String(member.id),
            name: String(member.name),
            status: typeof member.status === 'string' ? member.status : undefined,
            role: typeof member.role === 'string' ? member.role : undefined,
          })),
        halted: value?.halted === true,
      }
    } catch {
      return undefined
    }
  }

  /**
   * dsh-team 状态根候选。
   *
   * **只在本项目内找**：插件装配在 profile 层（全局），但「谁能看见谁」必须按项目隔离。
   * 早先这里会扫 `workspaceRegistry` 里所有 workspace，导致在 A 项目能列出 B 项目的
   * 团队成员 —— 既越权，也制造「看得到却发不出去」的假目标。
   *
   * 顺序：① 项目根下的状态目录 ② 项目根的子目录里可能存在的（例如 loop 这类嵌套项目）。
   * 绝不越过项目根。
   */
  private async candidateStateRoots(): Promise<string[]> {
    const roots: string[] = []
    const projectRoot = this.options.projectRoot

    // ① 项目根/<stateDir>
    roots.push(join(projectRoot, this.options.stateDir))

    // ② 项目根的直接子目录/<stateDir>（支持"项目里再套一个工作区"的布局）。
    //    只扫一层，且只接受确实位于项目根之下的路径。
    try {
      const dirents = await readdir(projectRoot, { withFileTypes: true })
      for (const entry of dirents) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') && entry.name !== this.options.stateDir.replace(/^\./, '.')) continue
        const candidate = join(projectRoot, entry.name, this.options.stateDir)
        if (!roots.includes(candidate)) roots.push(candidate)
      }
    } catch {
      /* 项目根读不到：只留 ① */
    }

    return roots
  }

  /** 解析并加载 @nanmicoder/dsh-agent-teams 的子模块。失败只记录，不抛。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const dir = this.options.packageDir ?? findPackageDir('@nanmicoder/dsh-agent-teams')
    if (dir === undefined) {
      this.lastError = '未能解析 @nanmicoder/dsh-agent-teams（检查它是否装在当前 profile）'
      return
    }
    this.resolvedDir = dir
    const loaded = await this.loadModules(dir)
    if (loaded) {
      this.mods = loaded
      // 有 deliverToMember/steerCaptainReport 才用 mailbox 模式；否则 fs-only。
      const members = loaded.members
      const hasDelivery =
        typeof members?.deliverToMember === 'function' || typeof members?.steerCaptainReport === 'function'
      this.localMode = hasDelivery ? 'mailbox' : 'fs-only'
      this.options.logger?.info?.(
        `[openclaw-dsh-bus] dsh-team adapter 就绪：${dir}（local mode = ${this.localMode}）`,
      )
    } else {
      this.lastError = `已找到 ${dir} 但子模块加载失败，adapter 用 fs-only 兜底`
      this.localMode = 'fs-only'
    }
    if (this.options.target === 'mailbox' && this.localMode !== 'mailbox') {
      this.lastError = (this.lastError ?? '') + '（配置要求 mailbox 模式但该版本不提供投递函数）'
    }
  }

  private async loadModules(
    dir: string,
  ): Promise<{ state?: any; mailbox?: any; members?: any; lineage?: any } | undefined> {
    const lib = join(dir, 'lib')
    const tryImport = async (name: string): Promise<any> => {
      const file = join(lib, `${name}.js`)
      if (!existsSync(file)) return undefined
      try {
        return await import(pathToFileURL(file).href)
      } catch (error) {
        this.options.logger?.warn?.(`[openclaw-dsh-bus] 加载 ${file} 失败：${String(error)}`)
        return undefined
      }
    }
    const state = await tryImport('state')
    if (state === undefined) return undefined
    return {
      state,
      mailbox: await tryImport('mailbox'),
      members: await tryImport('members'),
      lineage: await tryImport('lineage'),
    }
  }
}

function dirOfRoot(root: string): string {
  const parts = resolvePath(root).split(/[\\/]/)
  return parts.slice(0, -1).join('\\')
}

function randomId(): string {
  try {
    const req = createRequire(import.meta.url)
    return req('node:crypto').randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

/**
 * 解析目标插件包的**目录**（不 import，只要路径）。
 *
 * 为什么不能只靠 `createRequire(import.meta.url)`：
 * 本插件被 junction 链接进 profile，`import.meta.url` 解析到的是
 * `D:\openclaw-data\openclaw-dsh-bus\...`（链接的**目标**），
 * 从那里向上找不到 profile 的 node_modules —— 于是永远 MODULE_NOT_FOUND。
 *
 * 所以按可信度依次尝试：
 *   ① 显式环境变量（排障用）
 *   ② DSH_PROFILE_DIR（部分启动方式会设）
 *   ③ **DSH_HOME + DSH_PROFILE**（本机实测只有这两个，这是主路径）
 *   ④ 进程 cwd 向上找 node_modules（cwd 常是 profile 目录）
 *   ⑤ createRequire 从本模块解析（装在普通 node_modules 布局时有效）
 *
 * 每一步都只检查 package.json 是否存在，绝不因此抛错。
 */
export function findPackageDir(name: string): string | undefined {
  const fromEnv = process.env['OPENCLAW_DSH_BUS_DSH_TEAM_DIR']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && existsSync(fromEnv)) return fromEnv

  const parts = name.split('/')
  const candidates: string[] = []
  const pushIfDir = (candidate: string | undefined): void => {
    if (typeof candidate === 'string' && candidate !== '') candidates.push(candidate)
  }

  // ② DSH_PROFILE_DIR
  const profileDir = process.env['DSH_PROFILE_DIR']
  if (typeof profileDir === 'string' && profileDir !== '') {
    pushIfDir(join(profileDir, 'node_modules', ...parts))
  }

  // ③ DSH_HOME + DSH_PROFILE —— 本机唯一可用的组合
  const home = process.env['DSH_HOME']
  const profileName = process.env['DSH_PROFILE']
  if (typeof home === 'string' && home !== '') {
    if (typeof profileName === 'string' && profileName !== '') {
      pushIfDir(join(home, 'profiles', profileName, 'node_modules', ...parts))
    }
    // profile 名拿不到就扫 profiles/*（第一个命中的就是它）
    try {
      const profilesRoot = join(home, 'profiles')
      for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) pushIfDir(join(profilesRoot, entry.name, 'node_modules', ...parts))
      }
    } catch {
      /* 没有 profiles 目录也正常 */
    }
  }

  // ④ 从 cwd 逐级向上找 node_modules（宿主 cwd 通常就是 profile 目录）
  try {
    let current = process.cwd()
    for (let depth = 0; depth < 6; depth += 1) {
      pushIfDir(join(current, 'node_modules', ...parts))
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  } catch {
    /* ignore */
  }

  // ⑤ createRequire（普通安装布局时最准）
  try {
    const req = createRequire(import.meta.url)
    const mainUrl = req.resolve(name)
    const marker = parts.join('\\')
    const index = mainUrl.lastIndexOf(marker)
    pushIfDir(index >= 0 ? mainUrl.slice(0, index + marker.length) : dirname(mainUrl))
  } catch {
    /* junction 布局下必然失败，属预期 */
  }

  for (const candidate of candidates) {
    try {
      const normalized = resolvePath(candidate)
      if (existsSync(join(normalized, 'package.json'))) return normalized
    } catch {
      /* 下一个候选 */
    }
  }
  return undefined
}
