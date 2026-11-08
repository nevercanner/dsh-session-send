/**
 * 首次投递时的身份告知（onboarding）。
 *
 * ── 解决的问题 ──────────────────────────────────────────────────
 * 一个从没接触过总线的新会话，收到第一条消息时完全不知道：
 *   · 我是谁（在总线里的名字）
 *   · 这个项目里还有谁
 *   · 我该怎么回
 *
 * 光靠 `dsh_bus_agents` 不够 —— 它得先知道要调这个工具。
 * 所以第一次给某个会话投递时，**在消息正文前面附一段自我介绍**，
 * 之后不再附（避免每轮都刷）。
 *
 * ── 为什么不做成系统提示词注入 ──────────────────────────────────
 * 系统提示词是全局的，改它会影响所有会话（包括不参与总线的），
 * 而且插件热重载时不好收回。挂在「第一条消息」上是最小侵入：
 * 只有真的收到总线消息的会话才看到，且只看到一次。
 *
 * ── 记录在哪 ────────────────────────────────────────────────────
 * `<project>/.dsh-bus/greeted.json` —— 每个项目自己记谁已经被介绍过。
 * 放项目内而不是全局，是为了「项目隔离」这条线不被绕过。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const GREETED_FILE = 'greeted.json'

/** session id → 首次介绍时间。 */
export type GreetedRegistry = Record<string, number>

export function greetedPathFor(projectRoot: string): string {
  return join(projectRoot, '.dsh-bus', GREETED_FILE)
}

/** 读已介绍名单；缺失/损坏都返回空对象。 */
export async function readGreeted(projectRoot: string): Promise<GreetedRegistry> {
  const file = greetedPathFor(projectRoot)
  if (!existsSync(file)) return {}
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: GreetedRegistry = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 标记某会话已介绍过（原子写）。 */
export async function markGreeted(projectRoot: string, sessionId: string): Promise<void> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return
  const registry = await readGreeted(projectRoot)
  if (registry[id] !== undefined) return
  registry[id] = Date.now()
  const file = greetedPathFor(projectRoot)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

/** 一条可寻址会话的最小信息（用于生成通讯录）。 */
export interface RosterEntry {
  name: string
  /** 一句话说明这个 lane 做什么（来自 claims，可缺）。 */
  claim?: string
}

/**
 * 生成给新会话的自我介绍。
 *
 * 内容刻意精简：它出现在消息正文前面，太长会淹没真正的消息。
 * 只回答三个问题：你是谁、还有谁、怎么回。
 */
export function buildGreeting(options: {
  /** 这条消息要发给谁（会话自己的名字；还没报名则为 undefined）。 */
  selfName?: string
  /** 本项目其它参与者的通讯录（含自己也没关系 —— 内部会过滤掉）。 */
  roster: RosterEntry[]
  /** 本项目根（让人知道数据在哪，排障用）。 */
  projectRoot?: string
}): string {
  const lines: string[] = []
  // 通讯录过滤掉自己：让别人别给自己发消息，是很自然的困惑点。
  // 在函数内部过滤而不是要求调用方先过滤 —— 后者容易漏。
  const others =
    options.selfName === undefined || options.selfName === ''
      ? options.roster
      : options.roster.filter((entry) => entry.name !== options.selfName)

  lines.push('━━━ dsh-bus 首次接入说明（只出现一次）━━━')

  if (options.selfName !== undefined && options.selfName !== '') {
    lines.push(`你在总线里的名字：**${options.selfName}**`)
  } else {
    lines.push(
      '你还没有在总线里报名。想让别人能给你发消息，调用一次：',
      '  dsh_bus_register({ name: "<你的 lane 名>" })',
    )
  }

  if (others.length > 0) {
    lines.push('', '本项目已接入的其它会话：')
    for (const entry of others) {
      const suffix = entry.claim !== undefined && entry.claim !== '' ? ` —— ${entry.claim}` : ''
      lines.push(`  · ${entry.name}${suffix}`)
    }
    lines.push('', '发消息：dsh_bus_send({ to: "<上面任一个名字>", text: "..." })')
  } else {
    lines.push('', '本项目目前只有你一个会话报名。')
  }

  lines.push(
    '',
    '查看完整名册：dsh_bus_agents({})',
    '收到消息后要回复：dsh_bus_reply({ replyTo: "<消息 id>", text: "..." })',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  )

  return lines.join('\n')
}

/**
 * 判断这次投递是否应该附带自我介绍。
 *
 * @returns 需要附带时返回自我介绍文本；否则 undefined
 */
export async function greetingFor(options: {
  projectRoot: string
  targetId: string
  targetName?: string
  roster: RosterEntry[]
}): Promise<string | undefined> {
  const greeted = await readGreeted(options.projectRoot)
  if (greeted[options.targetId] !== undefined) return undefined

  const text = buildGreeting({
    selfName: options.targetName,
    // 不过滤也没关系：buildGreeting 内部会剔掉自己
    roster: options.roster,
    projectRoot: options.projectRoot,
  })
  await markGreeted(options.projectRoot, options.targetId)
  return text
}
