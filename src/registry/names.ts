/**
 * 会话名册（self-registration）—— 解决「会话没有可读名」的推广问题。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * 宿主的会话 `title` 是异步生成的，历史会话大多为空。
 * 121 个会话在列表里全是 `session-`，无法判断哪条是哪条工作线。
 *
 * 早期做法是让人在配置里手写 `{ "session-id": "跑章选手" }` —— 不能推广：
 *   · 要人去查 uuid，还得改配置文件；
 *   · 换项目、换会话就得重填；
 *   · 插件是给所有项目用的，不能要求每个项目都手工维护一张 id 表。
 *
 * ── 现在的做法：会话自己报名 ────────────────────────────────────
 * 每个会话调一次 `dsh_bus_register({ name: "管线维护" })`，
 * 插件把「自己是谁 + 叫什么」写进**项目内**的名册文件：
 *
 *   <workspace>/.dsh-bus/names.json
 *   { "session-4c72...": { "name": "管线维护", "at": 1794124151026 } }
 *
 * 之后：
 *   · 列表里直接显示这个名字
 *   · `to: "管线维护"` 直接能寻址
 *   · 名册跟着项目走，不进全局配置，不跨项目泄漏
 *
 * 优先级：**自注册名 > 配置 labels > 宿主 title > 兜底名**
 * （自注册最贴近实际情况；配置留给「想覆盖某个名字」的场合。）
 *
 * ── 并发与损坏 ─────────────────────────────────────────────────
 * 写入用「临时文件 + rename」原子替换；读失败按空名册处理，
 * 绝不因为一个坏文件让整个注册表不可用。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 名册条目。 */
export interface NameEntry {
  /** 会话给自己起的名字。 */
  name: string
  /** 报名时间（ms）。 */
  at: number
}

export type NameRegistry = Record<string, NameEntry>

/** 名册文件名（相对项目内的 .dsh-bus 目录）。 */
export const NAMES_FILE = 'names.json'

/** 名册文件完整路径。 */
export function namesPathFor(projectRoot: string): string {
  return join(projectRoot, '.dsh-bus', NAMES_FILE)
}

/**
 * 读名册。文件不存在 / 损坏都返回空对象（不抛）。
 *
 * @param projectRoot 项目根
 */
export async function readNames(projectRoot: string): Promise<NameRegistry> {
  const file = namesPathFor(projectRoot)
  if (!existsSync(file)) return {}
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: NameRegistry = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== 'string' || key.trim() === '') continue
      const entry = value as Partial<NameEntry> | null
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.name !== 'string' || entry.name.trim() === '') continue
      out[key] = {
        name: entry.name.trim(),
        at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
      }
    }
    return out
  } catch {
    // 名册损坏不该让注册表整个不可用：当作空名册，下次写入会重建。
    return {}
  }
}

/**
 * 写入一个会话的名字（原子替换）。
 *
 * @param projectRoot 项目根
 * @param sessionId   会话 id
 * @param name        名字（会 trim；空字符串视为「清除」）
 * @returns 写入后的完整名册
 */
export async function writeName(
  projectRoot: string,
  sessionId: string,
  name: string,
): Promise<NameRegistry> {
  const id = String(sessionId ?? '').trim()
  if (id === '') throw new Error('缺少 session id')
  const registry = await readNames(projectRoot)
  const trimmed = String(name ?? '').trim()
  if (trimmed === '') {
    delete registry[id]
  } else {
    registry[id] = { name: trimmed, at: Date.now() }
  }
  const file = namesPathFor(projectRoot)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
  return registry
}

/** 从名册里取一个名字；没有则 undefined。 */
export function nameOf(registry: NameRegistry, sessionId: string): string | undefined {
  const entry = registry[sessionId]
  if (entry === undefined) return undefined
  const name = entry.name.trim()
  return name === '' ? undefined : name
}

// ── 身份声明（claims）────────────────────────────────────────────
// 名册里的名字是「别人给起的」，claim 是「会话自己说的」。
// 两者分开存，才能发现批量报名时配错的 id —— 那种错误从名册本身看不出来
// （每个 id 都有名字），只有会话自述才能暴露。

/** 声明文件名。 */
export const CLAIMS_FILE = 'claims.json'

export interface ClaimEntry {
  /** 会话自述的 lane / 身份。 */
  claim: string
  at: number
}

export type ClaimRegistry = Record<string, ClaimEntry>

export function claimsPathFor(projectRoot: string): string {
  return join(projectRoot, '.dsh-bus', CLAIMS_FILE)
}

/** 读声明文件；缺失或损坏都返回空对象。 */
export async function readClaims(projectRoot: string): Promise<ClaimRegistry> {
  const file = claimsPathFor(projectRoot)
  if (!existsSync(file)) return {}
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: ClaimRegistry = {}
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Partial<ClaimEntry> | null
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.claim !== 'string' || entry.claim.trim() === '') continue
      out[key] = {
        claim: entry.claim.trim(),
        at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 写入一个会话的身份声明（原子替换）。 */
export async function writeClaim(
  projectRoot: string,
  sessionId: string,
  claim: string,
): Promise<ClaimRegistry> {
  const id = String(sessionId ?? '').trim()
  if (id === '') throw new Error('缺少 session id')
  const registry = await readClaims(projectRoot)
  const trimmed = String(claim ?? '').trim()
  if (trimmed === '') delete registry[id]
  else registry[id] = { claim: trimmed, at: Date.now() }

  const file = claimsPathFor(projectRoot)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
  return registry
}
