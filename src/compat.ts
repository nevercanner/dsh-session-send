/**
 * 宿主版本兼容性 fail-fast。
 *
 * 与 openclaw-weixin 的 src/compat.ts 同一思路：插件启动第一件事就是校验宿主，
 * 不兼容就**立刻抛错**，别在半坏状态下跑起来。
 *
 * 两种版本号都要认：
 *  - DSH：语义化 `0.2.1-rc.2`
 *  - OpenClaw：日期式 `2026.9.6`
 * 因此 `parseVersion` 同时产出 semver 段与日期段，比较时按同一族比。
 */

export const SUPPORTED_DSH_MIN = '0.2.1-rc.2'
/** 需要 node:sqlite（Node 22.5 起内置）与 `import.meta.resolve`。 */
export const SUPPORTED_NODE_MIN = [22, 5, 0] as const

export interface ParsedVersion {
  raw: string
  /** 数字段，如 0.2.1 → [0,2,1]；日期式 2026.9.6 → [2026,9,6] */
  numbers: number[]
  prerelease?: string
}

export function parseVersion(version: string | undefined): ParsedVersion | undefined {
  if (typeof version !== 'string') return undefined
  const trimmed = version.trim().replace(/^v/, '')
  if (trimmed === '' || trimmed === 'unknown') return undefined
  const [base, ...rest] = trimmed.split('-')
  const numbers = base.split('.').map((part) => Number(part))
  if (numbers.some((value) => Number.isNaN(value))) return undefined
  return { raw: trimmed, numbers, prerelease: rest.length === 0 ? undefined : rest.join('-') }
}

/** 逐段比较：a > b 返回 1，a < b 返回 -1。缺的段按 0 处理（0.2 == 0.2.0）。 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): -1 | 0 | 1 {
  const length = Math.max(left.numbers.length, right.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.numbers[index] ?? 0
    const b = right.numbers[index] ?? 0
    if (a < b) return -1
    if (a > b) return 1
  }
  // 数字段相同时：带预发布后缀的更低（0.2.1-rc.2 < 0.2.1）
  if (left.prerelease === undefined && right.prerelease !== undefined) return 1
  if (left.prerelease !== undefined && right.prerelease === undefined) return -1
  if (left.prerelease !== undefined && right.prerelease !== undefined) {
    const leftParts = left.prerelease.split('.')
    const rightParts = right.prerelease.split('.')
    const size = Math.max(leftParts.length, rightParts.length)
    for (let index = 0; index < size; index += 1) {
      const a = leftParts[index]
      const b = rightParts[index]
      if (a === undefined) return -1
      if (b === undefined) return 1
      const aNumeric = /^\d+$/.test(a)
      const bNumeric = /^\d+$/.test(b)
      if (aNumeric && bNumeric) {
        const delta = Number(a) - Number(b)
        if (delta !== 0) return delta < 0 ? -1 : 1
      } else if (aNumeric !== bNumeric) {
        return aNumeric ? -1 : 1
      } else if (a !== b) {
        return a < b ? -1 : 1
      }
    }
  }
  return 0
}

export function isDshVersionSupported(version: string | undefined): boolean {
  const host = parseVersion(version)
  const min = parseVersion(SUPPORTED_DSH_MIN)
  if (host === undefined || min === undefined) return false
  return compareVersions(host, min) >= 0
}

export function isNodeVersionSupported(version: string = process.versions.node): boolean {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  const [major = 0, minor = 0, patch = 0] = parsed.numbers
  const [needMajor, needMinor, needPatch] = SUPPORTED_NODE_MIN
  if (major !== needMajor) return major > needMajor
  if (minor !== needMinor) return minor > needMinor
  return patch >= needPatch
}

/**
 * fail-fast：版本不满足直接 throw。宿主版本号拿不到时**不抛**（与 openclaw-weixin 同款宽容），
 * 但要打警告——很多宿主不暴露 runtime.version，硬抛会让插件在正常环境里起不来。
 */
export function assertHostCompatibility(
  hostVersion: string | undefined,
  logger?: { info?(message: string): void; warn?(message: string): void },
): void {
  if (!isNodeVersionSupported()) {
    throw new Error(
      `dsh-session-send 需要 Node >= ${SUPPORTED_NODE_MIN.join('.')}（当前 ${process.versions.node}）：` +
        `sqlite transport 依赖内置 node:sqlite。请升级 Node，或把 transport.kind 改为 "file"。`,
    )
  }
  if (hostVersion === undefined || hostVersion.trim() === '' || hostVersion === 'unknown') {
    logger?.warn?.('[compat] 无法确定 DSH 宿主版本，跳过兼容性校验（功能可能不完整）')
    return
  }
  if (isDshVersionSupported(hostVersion)) {
    logger?.info?.(`[compat] DSH ${hostVersion} >= ${SUPPORTED_DSH_MIN}，OK`)
    return
  }
  throw new Error(
    `dsh-session-send 需要 DSH >= ${SUPPORTED_DSH_MIN}，当前 ${hostVersion}。` +
      `请升级 DSH，或使用匹配的插件版本。`,
  )
}

/** 兼容矩阵，供 /api 暴露与 UI 展示。 */
export function compatibilityReport(hostVersion: string | undefined): Record<string, unknown> {
  return {
    node: { version: process.versions.node, supported: isNodeVersionSupported() },
    dsh: {
      version: hostVersion ?? 'unknown',
      minimum: SUPPORTED_DSH_MIN,
      supported: hostVersion === undefined ? undefined : isDshVersionSupported(hostVersion),
    },
  }
}
