/**
 * file transport —— 无数据库环境（或想让人肉 tail 日志）时的替代实现。
 *
 * 落盘布局（`<dir>/` 下）：
 *   messages/<ts>-<id>.json   一条消息一个文件（内容就是 BusMessage）
 *   receipts/<target>.json    { "<messageId>": <readAt|0> } 已读表
 *
 * 与 sqlite 实现同一接口、同一语义；append 用「唯一文件名 + 原子 rename」，
 * 天然无写冲突。
 */
import { mkdir, readFile, readdir, rename, writeFile, rm, open } from 'node:fs/promises'
import { join } from 'node:path'
import { BusError, type BusMessage } from '../types.ts'
import type { ListQuery, Transport, UnreadCount } from './transport.ts'

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._@-]/g, '_')
}

export class FileTransport implements Transport {
  readonly kind = 'file'
  private readonly dir: string
  private readonly messagesDir: string
  private readonly receiptsDir: string

  constructor(options: { dir: string }) {
    this.dir = options.dir
    this.messagesDir = join(options.dir, 'messages')
    this.receiptsDir = join(options.dir, 'receipts')
  }

  async init(): Promise<void> {
    await mkdir(this.messagesDir, { recursive: true })
    await mkdir(this.receiptsDir, { recursive: true })
  }

  async append(message: BusMessage): Promise<BusMessage> {
    const [written] = await this.appendMany([message])
    return written
  }

  async appendMany(messages: BusMessage[]): Promise<BusMessage[]> {
    for (const message of messages) {
      await this.atomicWrite(join(this.messagesDir, `${message.ts}-${safeName(message.id)}.json`), JSON.stringify(message))
      await this.setReceipt(message.toId, message.id, 0)
      if (message.fromId !== message.toId) await this.setReceipt(message.fromId, message.id, message.ts)
    }
    return messages
  }

  async list(query: ListQuery = {}): Promise<BusMessage[]> {
    const files = await this.readDirSafe(this.messagesDir)
    const messages: BusMessage[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.messagesDir, file), 'utf8')
        const message = JSON.parse(raw) as BusMessage
        if (query.to !== undefined && query.to !== '*' && message.toId !== query.to) continue
        if (query.from !== undefined && message.fromId !== query.from) continue
        if (query.involving !== undefined && message.toId !== query.involving && message.fromId !== query.involving) continue
        if (query.sinceTs !== undefined && message.ts <= query.sinceTs) continue
        if (query.unreadOnly === true) {
          const receipts = await this.readReceipts(message.toId)
          if (receipts[message.id] !== 0) continue
          if (message.fromId === message.toId) continue
        }
        messages.push(message)
      } catch {
        /* 单条坏文件跳过，不影响整体 */
      }
    }
    messages.sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1))
    return messages.slice(0, Math.max(1, Math.min(query.limit ?? 200, 1000)))
  }

  async markRead(target: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const receipts = await this.readReceipts(target)
    const now = Date.now()
    let changed = 0
    for (const id of ids) {
      if (receipts[id] === 0) {
        receipts[id] = now
        changed += 1
      }
    }
    if (changed > 0) await this.writeReceipts(target, receipts)
    return changed
  }

  async unread(targets: string[]): Promise<UnreadCount[]> {
    const messages = await this.list({ limit: 1000 })
    const result: UnreadCount[] = []
    for (const target of targets) {
      const receipts = await this.readReceipts(target)
      const count = messages.filter((message) => message.toId === target && message.fromId !== target && receipts[message.id] === 0)
        .length
      result.push({ target, count })
    }
    return result
  }

  async get(id: string): Promise<BusMessage | undefined> {
    const files = await this.readDirSafe(this.messagesDir)
    for (const file of files) {
      if (!file.includes(safeName(id))) continue
      try {
        return JSON.parse(await readFile(join(this.messagesDir, file), 'utf8')) as BusMessage
      } catch {
        /* ignore */
      }
    }
    return undefined
  }

  async dispose(): Promise<void> {
    /* 无长连接资源 */
  }

  private async readDirSafe(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return []
      throw new BusError('E_TRANSPORT', `读取目录失败 ${dir}: ${String(error)}`)
    }
  }

  private async readReceipts(target: string): Promise<Record<string, number>> {
    const file = join(this.receiptsDir, `${safeName(target)}.json`)
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, number>
    } catch {
      return {}
    }
  }

  private async writeReceipts(target: string, receipts: Record<string, number>): Promise<void> {
    await this.atomicWrite(join(this.receiptsDir, `${safeName(target)}.json`), JSON.stringify(receipts))
  }

  private async setReceipt(target: string, id: string, readAt: number): Promise<void> {
    const receipts = await this.readReceipts(target)
    receipts[id] = readAt
    await this.writeReceipts(target, receipts)
  }

  /** 一份写临时文件再 rename，避免半截 JSON。 */
  private async atomicWrite(file: string, content: string): Promise<void> {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, file)
  }
}

/** 保证目录存在的小工具（ops 脚本也用它）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** 用独占锁文件串行化跨进程写的工具（目前未被 transport 内部使用，留给运维脚本）。 */
export async function withFileLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(dir, '.lock')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      handle = await open(lock, 'wx')
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  if (handle === undefined) throw new BusError('E_TRANSPORT', `无法获取文件锁 ${lock}`)
  try {
    return await operation()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(lock, { force: true }).catch(() => undefined)
  }
}
