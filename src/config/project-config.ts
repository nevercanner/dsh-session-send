/**
 * 项目级配置（**DSH 侧**）—— 本插件唯一的业务开关。
 *
 * ── 定位纠正（重要）──────────────────────────────────────────
 * 本插件运行在 **DSH** 宿主里，不是 OpenClaw 插件。因此：
 *   · 绝不去读/写 `openclaw.json` —— 那是另一个宿主的进程配置，
 *     往里塞本插件的键对 OpenClaw 来说是外部垃圾数据，对 DSH 来说是越界耦合；
 *   · 开关放在 **被启用项目的根目录** 下的一个独立文件里，天然满足
 *     「仅本项目内生效」：不同 workspace 有各自的文件，谁也不影响谁。
 *
 * 参考的是 OpenClaw 的**做法**（`session send` 的消息语义、agent 之间的寻址方式），
 * 不是 OpenClaw 的**配置文件**。
 *
 * ── 文件约定 ─────────────────────────────────────────────────
 * 路径：`<workspace>/.dsh-bus.json`（文件名可由 Config.projectConfigName 改）
 * 不存在 = 本项目不启用（默认）。存在且 `enabled: true` = 本项目启用。
 *
 * ```json
 * {
 *   "enabled": true,
 *   "transport": { "kind": "sqlite" },
 *   "router": { "allowBroadcast": true }
 * }
 * ```
 *
 * 文件里只需要写想覆盖的字段；其余落到 DEFAULT_CONFIG。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BusConfig } from '../types.ts'
import { mergeConfig, validateConfig, type ConfigValidation } from './schema.ts'

/** 默认的项目级配置文件名（相对 workspace 根）。 */
export const DEFAULT_PROJECT_CONFIG_NAME = '.dsh-bus.json'

export interface LoadedProjectConfig extends ConfigValidation {
  /** 项目根（workspace 路径）。 */
  projectRoot: string
  /** 项目配置文件的完整路径。 */
  projectConfigPath: string
  /** 文件是否存在。不存在 = 本项目未启用。 */
  present: boolean
  /** 是否存在但读不出来（坏 JSON / 权限）。此时强制关闭。 */
  degraded: boolean
}

export interface LoadProjectConfigOptions {
  /** 项目根（绝对路径）。 */
  projectRoot: string
  /** 项目配置文件名，默认 `.dsh-bus.json`。 */
  configName?: string
  /** profile 侧（cordis.patch.yml）配置，作为默认值垫底。 */
  baseConfig?: Partial<BusConfig>
  logger?: { warn?(message: string): void }
}

export async function loadProjectConfig(options: LoadProjectConfigOptions): Promise<LoadedProjectConfig> {
  const projectRoot = options.projectRoot
  const configName = options.configName ?? DEFAULT_PROJECT_CONFIG_NAME
  const projectConfigPath = join(projectRoot, configName)
  const warnings: string[] = []
  let present = false
  let degraded = false
  let block: unknown

  if (!existsSync(projectConfigPath)) {
    // 默认状态：文件不存在 → 本项目不启用。这是设计要求的默认关闭，不是错误。
  } else {
    present = true
    try {
      const raw = await readFile(projectConfigPath, 'utf8')
      block = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch (error) {
      degraded = true
      warnings.push(`${configName} 读取/解析失败：${String(error)}（本项目总线保持关闭）`)
    }
  }

  const merged = mergeConfig(options.baseConfig, (block ?? {}) as Partial<BusConfig>)
  const validation = await validateConfig(merged)
  warnings.push(...validation.warnings)

  if (degraded) {
    // 配置不明就绝不开放通信：宁可关着。
    validation.value.enabled = false
  }
  // 项目文件不存在时也强制关闭（即使 profile patch 里 enabled=true）——
  // 「仅项目内手动开启」是硬约束，不能靠 profile 一次性放开所有项目。
  if (!present) {
    validation.value.enabled = false
  }

  for (const warning of warnings) options.logger?.warn?.(`[dsh-session-send] ${warning}`)

  return {
    value: validation.value,
    warnings,
    projectRoot,
    projectConfigPath,
    present,
    degraded,
  }
}

/** 给 UI 展示的一句话说明：为什么现在没开。 */
export function disabledReason(loaded: LoadedProjectConfig): string {
  if (loaded.degraded) return `${DEFAULT_PROJECT_CONFIG_NAME} 解析失败，已强制关闭`
  if (!loaded.present) return `本项目未启用：${loaded.projectConfigPath} 不存在`
  if (!loaded.value.enabled) return `${loaded.projectConfigPath} 里 enabled 不是 true`
  return ''
}
