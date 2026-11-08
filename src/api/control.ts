/**
 * control 层：项目开关的**写入口**。
 *
 * 这是整个插件里唯一会写文件的地方 —— 而它只写一件事：
 * 把 `<workspace>/.dsh-bus.json` 里的 `enabled` 翻转。
 *
 * 设计要点：
 *  · 只改 `enabled` 一个字段，**保留用户手写的其它字段**（transport.kind、
 *    router.allowBroadcast 等）。关掉不是删文件，是把 enabled 置 false，
 *    这样用户的自定义配置不会因为一次点击而丢失。
 *  · 不碰 openclaw.json，不碰任何项目外的路径。
 *  · workspace 根由宿主（session 的 cwd / workingDirectory）决定，不由请求体自述 ——
 *    否则等于让 UI 决定「能改哪个目录的开关」，那是越权。
 *  · 写入用「临时文件 + rename」原子替换，避免半截 JSON 让下次启动读出 degraded。
 *
 * 分层：control 只依赖 fs + types + 一个「读当前状态 / 重新装配」的回调，
 * 不认识 transport / registry / router 的实现。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { BusError, type BusConfig } from '../types.ts'
import { DEFAULT_PROJECT_CONFIG_NAME } from '../config/project-config.ts'

/** 一个项目的开关快照（UI 直接渲染）。 */
export interface ProjectSwitchState {
  /** 项目根（绝对路径）。 */
  projectRoot: string
  /** 配置文件完整路径。 */
  projectConfigPath: string
  /** 配置文件是否存在。 */
  present: boolean
  /** 当前是否开启。 */
  enabled: boolean
  /** 未开启时的一句话原因。 */
  reason?: string
  /** 解析不了配置时的错误（存在即为 degraded）。 */
  error?: string
}

export interface ControlOptions {
  /** 项目配置文件名，默认 `.dsh-bus.json`。 */
  configName?: string
  /** 读某个项目根此刻的开关状态（由装配层提供，保证与运行时一致）。 */
  readState(projectRoot: string): Promise<ProjectSwitchState>
  /** 配置变更后重新装配（热生效，不需要重启宿主）。 */
  reconfigure(projectRoot: string): Promise<ProjectSwitchState>
  logger?: { warn?(message: string): void }
}

export interface ProjectControl {
  /** 读状态（不写）。 */
  status(projectRoot: string): Promise<ProjectSwitchState>
  /** 翻转开关并热生效。 */
  toggle(projectRoot: string): Promise<ProjectSwitchState>
  /** 显式设置（幂等；UI 只在已知目标态时用）。 */
  set(projectRoot: string, enabled: boolean): Promise<ProjectSwitchState>
}

/** 把任意输入归一成一个**可信的绝对项目根**。 */
export function normalizeProjectRoot(input: string): string {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '') {
    throw new BusError('E_TARGET_NOT_FOUND', '缺少项目根：无法确定要切换哪个项目')
  }
  return resolvePath(trimmed)
}

/** 读现有配置文件的原始对象（不存在/坏文件都返回 {}，并给出是否可读）。 */
export async function readRawProjectConfig(
  file: string,
): Promise<{ raw: Record<string, unknown>; existed: boolean; error?: string }> {
  if (!existsSync(file)) return { raw: {}, existed: false }
  try {
    const text = await readFile(file, 'utf8')
    if (text.trim() === '') return { raw: {}, existed: true }
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { raw: {}, existed: true, error: '配置文件不是 JSON 对象' }
    }
    return { raw: parsed as Record<string, unknown>, existed: true }
  } catch (error) {
    return { raw: {}, existed: true, error: `配置文件解析失败：${String(error)}` }
  }
}

/**
 * 原子写入：先写 `.tmp` 再 rename。
 * 直接 writeFile 在断电/并发下可能留下半截 JSON，下次启动会读到 degraded 而强制关闭。
 */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

export function createProjectControl(options: ControlOptions): ProjectControl {
  const configName = options.configName ?? DEFAULT_PROJECT_CONFIG_NAME

  async function writeEnabled(projectRoot: string, enabled: boolean): Promise<void> {
    const file = join(projectRoot, configName)
    const existing = await readRawProjectConfig(file)
    // 文件坏了就先不覆盖 —— 覆盖等于悄悄丢掉用户写的内容，还掩盖了错误。
    if (existing.error !== undefined) {
      throw new BusError('E_TRANSPORT', `${configName} 已损坏（${existing.error}），先修好它再切换`, {
        projectConfigPath: file,
      })
    }
    const next: Record<string, unknown> = {
      ...existing.raw,
      enabled,
      // 首次创建时给一份能直接跑的最小配置；已有文件不动其它字段。
      ...(existing.existed ? {} : { transport: { kind: 'sqlite' } }),
    }
    if (next['scope'] === undefined) next['scope'] = 'project'
    await atomicWriteJson(file, next)
  }

  return {
    async status(projectRoot: string): Promise<ProjectSwitchState> {
      const root = normalizeProjectRoot(projectRoot)
      return options.readState(root)
    },

    async set(projectRoot: string, enabled: boolean): Promise<ProjectSwitchState> {
      const root = normalizeProjectRoot(projectRoot)
      const current = await options.readState(root)
      if (current.present && current.enabled === enabled) {
        // 已经是目标态：不重复写盘，但仍返回一致状态。
        return current
      }
      await writeEnabled(root, enabled)
      return options.reconfigure(root)
    },

    async toggle(projectRoot: string): Promise<ProjectSwitchState> {
      const root = normalizeProjectRoot(projectRoot)
      const current = await options.readState(root)
      return this.set(root, !current.enabled)
    },
  }
}

/** 供 UI 展示：当前配置里用户自己设过的非默认字段（让「关掉不丢配置」可见）。 */
export async function describeProjectFile(
  projectRoot: string,
  configName = DEFAULT_PROJECT_CONFIG_NAME,
): Promise<{ path: string; raw: Record<string, unknown> }> {
  const file = join(normalizeProjectRoot(projectRoot), configName)
  const existed = await readRawProjectConfig(file)
  return { path: file, raw: existed.raw }
}

export type { BusConfig }
