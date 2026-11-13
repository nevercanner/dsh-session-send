/**
 * 配置校验（zod / 降级双路径）。
 *
 * 语义：**默认放行**（与 dsh-context-bridge 一致）。文件缺失 / 字段缺失 = 可用，
 *    只有显式写 enabled=false 才关闭 —— 项目级开关默认不该拦新项目。
 *
 * 注意配置的来源：本插件是 **DSH** 插件，项目级开关来自
 * `<workspace>/.dsh-bus.json`（见 ./project-config.ts），
 * 与 OpenClaw 的 `openclaw.json` **无关**，本文件也不引用它。
 */
import type { BusConfig, TransportKind, RegistrySource } from '../types.ts'
import { importZod } from '../host-modules.ts'

export const TRANSPORT_KINDS: readonly TransportKind[] = ['sqlite', 'file', 'in-process']

export const DEFAULT_CONFIG: BusConfig = {
  enabled: true,
  scope: 'project',
  transport: { kind: 'sqlite' },
  registry: { sources: ['dsh-team', 'dsh-sessions'], stateDir: '.agent-teams', requireRegistration: true },
  router: {
    allowBroadcast: true,
    maxPayloadChars: 20000,
    dshTeam: { enabled: true, target: 'auto' },
    redeliver: { enabled: false, maxAttempts: 3 },
  },
  labels: {},
  ui: { entry: true, pollMs: 4000 },
}

/** 校验结果：`value` 是补齐默认值后的完整配置，`warnings` 是可展示给人看的降级说明。 */
export interface ConfigValidation {
  value: BusConfig
  warnings: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asBool(value: unknown, fallback: boolean, path: string, warnings: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${path} 期望 boolean，实际 ${typeof value}，已回落为 ${String(fallback)}`)
  return fallback
}

function asInt(value: unknown, fallback: number, path: string, warnings: string[], min = 0): number {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min) return value
  warnings.push(`${path} 期望 >=${min} 的整数，实际 ${JSON.stringify(value)}，已回落为 ${fallback}`)
  return fallback
}

function asString(value: unknown, fallback: string, path: string, warnings: string[]): string {
  if (value === undefined) return fallback
  if (typeof value === 'string' && value.trim() !== '') return value
  warnings.push(`${path} 期望非空字符串，实际 ${JSON.stringify(value)}，已回落为 ${fallback}`)
  return fallback
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  warnings: string[],
): T {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  warnings.push(`${path} 只接受 ${allowed.join(' | ')}，实际 ${JSON.stringify(value)}，已回落为 ${fallback}`)
  return fallback
}

/**
 * 降级校验：不抛异常、只回落到安全默认值并记录 warnings。
 * `scope` 强制为 'project' —— 本插件在设计上不允许全局生效形态。
 */
export function validateFallback(raw: unknown): ConfigValidation {
  const warnings: string[] = []
  if (!isObject(raw)) {
    return { value: structuredClone(DEFAULT_CONFIG), warnings: ['配置不是对象，已整体使用默认值（enabled=true，默认放行）'] }
  }

  if (raw['scope'] !== undefined && raw['scope'] !== 'project') {
    warnings.push(`scope 只支持 "project"（当前 ${JSON.stringify(raw['scope'])}），已强制为 "project"`)
  }

  const transportRaw = isObject(raw['transport']) ? raw['transport'] : {}
  const registryRaw = isObject(raw['registry']) ? raw['registry'] : {}
  const routerRaw = isObject(raw['router']) ? raw['router'] : {}
  const dshTeamRaw = isObject(routerRaw['dshTeam']) ? routerRaw['dshTeam'] : {}
  const redeliverRaw = isObject(routerRaw['redeliver']) ? routerRaw['redeliver'] : {}
  const uiRaw = isObject(raw['ui']) ? raw['ui'] : {}

  // labels：session id → 可读名。只接受字符串值，忽略其它类型。
  const labelsRaw = isObject(raw['labels']) ? raw['labels'] : {}
  const labels: Record<string, string> = {}
  for (const [key, value] of Object.entries(labelsRaw)) {
    if (typeof value === 'string' && value.trim() !== '') labels[key.trim()] = value.trim()
    else warnings.push(`labels["${key}"] 期望非空字符串，已忽略`)
  }

  const sourcesRaw = registryRaw['sources']
  const allowedSources: RegistrySource[] = ['dsh-team', 'dsh-sessions']
  let sources: RegistrySource[] = [...DEFAULT_CONFIG.registry.sources]
  if (Array.isArray(sourcesRaw)) {
    const picked = sourcesRaw.filter((item): item is RegistrySource =>
      typeof item === 'string' && (allowedSources as readonly string[]).includes(item),
    )
    if (picked.length !== sourcesRaw.length) {
      warnings.push(`registry.sources 含未知来源，已忽略；可用值 ${allowedSources.join(' | ')}`)
    }
    sources = picked
  } else if (sourcesRaw !== undefined) {
    warnings.push('registry.sources 期望数组，已使用默认来源')
  }

  const value: BusConfig = {
    enabled: asBool(raw['enabled'], DEFAULT_CONFIG.enabled, 'enabled', warnings),
    scope: 'project',
    transport: {
      kind: asEnum(transportRaw['kind'], TRANSPORT_KINDS, DEFAULT_CONFIG.transport.kind, 'transport.kind', warnings),
      sqlitePath: typeof transportRaw['sqlitePath'] === 'string' ? transportRaw['sqlitePath'] : undefined,
      fileDir: typeof transportRaw['fileDir'] === 'string' ? transportRaw['fileDir'] : undefined,
    },
    registry: {
      sources,
      stateDir: asString(registryRaw['stateDir'], DEFAULT_CONFIG.registry.stateDir, 'registry.stateDir', warnings),
      requireRegistration: asBool(
        registryRaw['requireRegistration'],
        DEFAULT_CONFIG.registry.requireRegistration,
        'registry.requireRegistration',
        warnings,
      ),
    },
    router: {
      allowBroadcast: asBool(
        routerRaw['allowBroadcast'],
        DEFAULT_CONFIG.router.allowBroadcast,
        'router.allowBroadcast',
        warnings,
      ),
      maxPayloadChars: asInt(
        routerRaw['maxPayloadChars'],
        DEFAULT_CONFIG.router.maxPayloadChars,
        'router.maxPayloadChars',
        warnings,
        64,
      ),
      dshTeam: {
        enabled: asBool(dshTeamRaw['enabled'], DEFAULT_CONFIG.router.dshTeam.enabled, 'router.dshTeam.enabled', warnings),
        target: asEnum(
          dshTeamRaw['target'],
          ['auto', 'service', 'mailbox'] as const,
          DEFAULT_CONFIG.router.dshTeam.target,
          'router.dshTeam.target',
          warnings,
        ),
      },
      redeliver: {
        enabled: asBool(redeliverRaw['enabled'], DEFAULT_CONFIG.router.redeliver.enabled, 'router.redeliver.enabled', warnings),
        maxAttempts: asInt(
          redeliverRaw['maxAttempts'],
          DEFAULT_CONFIG.router.redeliver.maxAttempts,
          'router.redeliver.maxAttempts',
          warnings,
          1,
        ),
      },
    },
    labels,
    ui: {
      entry: asBool(uiRaw['entry'], DEFAULT_CONFIG.ui.entry, 'ui.entry', warnings),
      pollMs: asInt(uiRaw['pollMs'], DEFAULT_CONFIG.ui.pollMs, 'ui.pollMs', warnings, 500),
    },
  }
  return { value, warnings }
}

/** zod 版 schema（仅在 zod 可解析时构造，避免静态依赖）。 */
export function createZodSchema(z: any): any {
  const transport = z.object({
    kind: z.enum(['sqlite', 'file', 'in-process']).default('sqlite'),
    sqlitePath: z.string().optional(),
    fileDir: z.string().optional(),
  })
  const registry = z.object({
    sources: z.array(z.enum(['dsh-team', 'dsh-sessions'])).default(['dsh-team', 'dsh-sessions']),
    stateDir: z.string().default('.agent-teams'),
    requireRegistration: z.boolean().default(true),
  })
  const router = z.object({
    allowBroadcast: z.boolean().default(true),
    maxPayloadChars: z.number().int().min(64).default(20000),
    dshTeam: z
      .object({
        enabled: z.boolean().default(true),
        target: z.enum(['auto', 'service', 'mailbox']).default('auto'),
      })
      .default({ enabled: true, target: 'auto' }),
    redeliver: z
      .object({
        enabled: z.boolean().default(false),
        maxAttempts: z.number().int().min(1).max(20).default(3),
      })
      .default({ enabled: false, maxAttempts: 3 }),
  })
  const ui = z.object({
    entry: z.boolean().default(true),
    pollMs: z.number().int().min(500).default(4000),
  })
  return z.object({
    enabled: z.boolean().default(true),
    scope: z.literal('project').default('project'),
    transport: transport.default({ kind: 'sqlite' }),
    registry: registry.default({ sources: ['dsh-team', 'dsh-sessions'], stateDir: '.agent-teams', requireRegistration: true }),
    router: router.default({
      allowBroadcast: true,
      maxPayloadChars: 20000,
      dshTeam: { enabled: true, target: 'auto' },
      redeliver: { enabled: false, maxAttempts: 3 },
    }),
    labels: z.record(z.string(), z.string()).default({}),
    ui: ui.default({ entry: true, pollMs: 4000 }),
  })
}

/**
 * 主校验入口：zod 可用走严格校验，否则走降级校验。
 * 严格校验失败**不抛**给宿主，而是带着 warnings 回落 —— 一个手滑的配置字段
 * 不该让整个 dsh 启动失败。
 */
export async function validateConfig(raw: unknown): Promise<ConfigValidation> {
  const z = await importZod()
  if (z === undefined) {
    const fallback = validateFallback(raw)
    fallback.warnings.push('zod 不可解析，已使用降级校验（字段类型宽松检查）')
    return fallback
  }
  try {
    const schema = createZodSchema(z)
    const parsed = schema.parse(raw ?? {})
    return { value: parsed as BusConfig, warnings: [] }
  } catch (error) {
    const fallback = validateFallback(raw)
    fallback.warnings.push(`zod 严格校验未通过（${error instanceof Error ? error.message : String(error)}），已降级`)
    return fallback
  }
}

/** 合并两份配置：base 作为底，override 覆盖（对象深合并一层）。 */
export function mergeConfig(base: Partial<BusConfig> | undefined, override: Partial<BusConfig> | undefined): unknown {
  const merged: Record<string, unknown> = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(override ?? {})) {
    const left = merged[key]
    merged[key] = isObject(left) && isObject(value) ? { ...left, ...value } : value
  }
  return merged
}
