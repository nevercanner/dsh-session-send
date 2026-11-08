/**
 * registry 层接口。
 *
 * 硬约束：
 *  - 只认 ../types.ts；不 import transport / router / ui；
 *  - 不读任何配置文件（配置由上层注入）；
 *  - 「注册表」= 把当前有哪些可寻址的 agent / session 列出来，并提供按 id/name 解析。
 *
 * 具体来源（dsh-team / dsh sessions）各自实现 RegistryProvider，
 * 由 CompositeRegistry 聚合 —— dsh-team 只出现在 ./dsh-team-adapter.ts 一处。
 */
import type { AgentEntry, RegistrySource } from '../types.ts'

export interface RegistryProvider {
  readonly source: RegistrySource
  /** 列出当前可寻址条目。不可用时返回空数组，不抛。 */
  list(): Promise<AgentEntry[]>
  /** 解析一个引用（id / name / label）。多个命中时返回全部，由上层判定歧义。 */
  resolve(ref: string): Promise<AgentEntry[]>
  /** 该 provider 此刻是否可用（用于 UI 上标灰）。 */
  available(): Promise<boolean>
}

export interface Registry {
  /** 聚合所有 provider 的条目（按 id 去重，先注册的 provider 优先）。 */
  list(): Promise<AgentEntry[]>
  /** 解析引用；空数组 = 不存在。 */
  resolve(ref: string): Promise<AgentEntry[]>
  /** 广播目标：除发送方以外的全部条目。 */
  broadcastTargets(from: string): Promise<AgentEntry[]>
  /** 每个来源的可用性快照。 */
  sources(): Promise<Array<{ source: RegistrySource; available: boolean; count: number }>>
}

/** 引用归一：trim + 去 @ 前缀（便于 `@leader` 这种写法）。 */
export function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

export class CompositeRegistry implements Registry {
  private readonly providers: RegistryProvider[]

  constructor(providers: RegistryProvider[]) {
    this.providers = providers
  }

  async list(): Promise<AgentEntry[]> {
    const seen = new Set<string>()
    const entries: AgentEntry[] = []
    for (const provider of this.providers) {
      let rows: AgentEntry[] = []
      try {
        rows = await provider.list()
      } catch {
        rows = []
      }
      for (const entry of rows) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        entries.push(entry)
      }
    }
    return entries
  }

  /**
   * 列出所有会话（含未报名的）—— 只用于「报名前的项目归属校验」与诊断。
   * 不参与寻址。
   */
  async listAll(): Promise<AgentEntry[]> {
    const seen = new Set<string>()
    const entries: AgentEntry[] = []
    for (const provider of this.providers) {
      let rows: AgentEntry[] = []
      try {
        const withAll = provider as unknown as { listAll?: () => Promise<AgentEntry[]> }
        rows = typeof withAll.listAll === 'function' ? await withAll.listAll() : await provider.list()
      } catch {
        rows = []
      }
      for (const entry of rows) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        entries.push(entry)
      }
    }
    return entries
  }

  async resolve(ref: string): Promise<AgentEntry[]> {
    const normalized = normalizeRef(ref)
    if (normalized === '') return []
    const hits: AgentEntry[] = []
    const seen = new Set<string>()
    for (const provider of this.providers) {
      let rows: AgentEntry[] = []
      try {
        rows = await provider.resolve(normalized)
      } catch {
        rows = []
      }
      for (const entry of rows) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        hits.push(entry)
      }
    }
    return hits
  }

  async broadcastTargets(from: string): Promise<AgentEntry[]> {
    const normalized = normalizeRef(from)
    const entries = await this.list()
    return entries.filter((entry) => entry.id !== normalized && entry.name !== normalized)
  }

  async sources(): Promise<Array<{ source: RegistrySource; available: boolean; count: number }>> {
    const result: Array<{ source: RegistrySource; available: boolean; count: number }> = []
    for (const provider of this.providers) {
      let available = false
      let count = 0
      try {
        available = await provider.available()
        if (available) count = (await provider.list()).length
      } catch {
        available = false
      }
      result.push({ source: provider.source, available, count })
    }
    return result
  }
}
