/**
 * 宿主包的解析器。
 *
 * 一个本地插件包 `D:\openclaw-data\openclaw-dsh-bus` 在开发期**没有** node_modules：
 * 它被 junction 链接进 profile 后才由 profile 提供 `@deepseek-ai/*`。
 *
 * 解决办法（与 dsh-task-ledger 的 loadSchemastery 同一个思路，只是做得更彻底）：
 * 按候选根目录依次尝试解析，并且**任何一步失败都降级为 undefined**，
 * 绝不让一个可选依赖把整个插件入口带崩。
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

export interface HostResolveOptions {
  /** 额外候选根（测试注入）。 */
  roots?: string[]
}

/** 候选的 node_modules 根，按可信度排序。 */
function candidateRoots(): string[] {
  const roots: string[] = []
  const profileDir = process.env['DSH_PROFILE_DIR']
  if (typeof profileDir === 'string' && profileDir !== '') roots.push(profileDir)
  // 宿主 dsh 安装目录（插件被 profile 链接时最准的就是这个）
  const execPath = process.execPath
  if (typeof execPath === 'string') {
    roots.push(join(execPath, '..', 'resources', 'app', 'dsh'))
  }
  // 插件自身（被 pnpm 装进 profile/node_modules 时，向上两级就是 profile）
  try {
    roots.push(fileURLToPath(new URL('.', import.meta.url)))
  } catch {
    /* ignore */
  }
  roots.push(process.cwd())
  return roots
}

/** 用 createRequire 从候选根解析一个包；解析不到返回 undefined。 */
export function resolveHostPackage(specifier: string, options: HostResolveOptions = {}): string | undefined {
  const roots = [...(options.roots ?? []), ...candidateRoots()]
  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'index.js'))
      return require.resolve(specifier)
    } catch {
      /* 下一个候选 */
    }
  }
  return undefined
}

/** 动态 import 一个宿主包（解析 + 加载都失败时返回 undefined）。 */
export async function importHostPackage(specifier: string, options: HostResolveOptions = {}): Promise<any | undefined> {
  const resolved = resolveHostPackage(specifier, options)
  if (resolved === undefined) return undefined
  try {
    return await import(pathToFileURL(resolved).href)
  } catch {
    return undefined
  }
}

/** schemastery 的专用便捷入口（插件入口用）。 */
export async function importSchemastery(): Promise<any | undefined> {
  return importHostPackage('@deepseek-ai/schemastery')
}

/** zod 的专用便捷入口（配置严格校验用）。 */
export async function importZod(): Promise<any | undefined> {
  const module: any = await importHostPackage('zod')
  if (module === undefined) return undefined
  return module?.z ?? module?.default ?? module
}
