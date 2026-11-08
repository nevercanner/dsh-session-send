/**
 * in-process transport —— 纯内存实现。
 *
 * 用途：单元测试、以及「只需要当前进程内几条 session 互发」的临时场景。
 * 明确不持久化：进程结束即丢。若配置指到它，UI 上会标注「非持久」。
 */
import { BusError, type BusMessage } from '../types.ts'
import type { ListQuery, Transport, UnreadCount } from './transport.ts'

interface Stored {
  message: BusMessage
  readAt: Map<string, number>
}

export class InProcessTransport implements Transport {
  readonly kind = 'in-process'
  private readonly store = new Map<string, Stored>()
  private closed = false

  async init(): Promise<void> {
    /* 无外部资源 */
  }

  async append(message: BusMessage): Promise<BusMessage> {
    const [written] = await this.appendMany([message])
    return written
  }

  async appendMany(messages: BusMessage[]): Promise<BusMessage[]> {
    if (this.closed) throw new BusError('E_TRANSPORT', 'in-process transport 已关闭')
    for (const message of messages) {
      const readAt = new Map<string, number>()
      if (message.fromId !== message.toId) readAt.set(message.fromId, message.ts)
      this.store.set(message.id, { message, readAt })
    }
    return messages
  }

  async list(query: ListQuery = {}): Promise<BusMessage[]> {
    const all = [...this.store.values()]
      .filter((entry) => {
        const { message, readAt } = entry
        if (query.to !== undefined && query.to !== '*' && message.toId !== query.to) return false
        if (query.from !== undefined && message.fromId !== query.from) return false
        if (query.involving !== undefined && message.toId !== query.involving && message.fromId !== query.involving) return false
        if (query.sinceTs !== undefined && message.ts <= query.sinceTs) return false
        if (query.unreadOnly === true) {
          if (message.fromId === message.toId) return false
          if ((readAt.get(message.toId) ?? 0) !== 0) return false
        }
        return true
      })
      .map((entry) => entry.message)
      .sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1))
    return all.slice(0, Math.max(1, Math.min(query.limit ?? 200, 1000)))
  }

  async markRead(target: string, ids: string[]): Promise<number> {
    const now = Date.now()
    let changed = 0
    for (const id of ids) {
      const entry = this.store.get(id)
      if (entry === undefined) continue
      if ((entry.readAt.get(target) ?? 0) === 0 && entry.message.toId === target) {
        entry.readAt.set(target, now)
        changed += 1
      }
    }
    return changed
  }

  async unread(targets: string[]): Promise<UnreadCount[]> {
    const all = [...this.store.values()]
    return targets.map((target) => ({
      target,
      count: all.filter(
        (entry) =>
          entry.message.toId === target &&
          entry.message.fromId !== target &&
          (entry.readAt.get(target) ?? 0) === 0,
      ).length,
    }))
  }

  async get(id: string): Promise<BusMessage | undefined> {
    return this.store.get(id)?.message
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.store.clear()
  }
}
