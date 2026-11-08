/**
 * sqlite transport —— 默认实现。
 *
 * 存储位置：**项目内** `<workspace>/.dsh-bus/bus.db`。
 *
 * 为什么不去 openclaw-data 的 `chat_shared.db` 建表（定位纠正）：
 * 那是 OpenClaw ↔ DeepSeek bridge 的共享库，属于**另一个宿主的运行数据**。
 * 本插件是 DSH 插件，「仅项目内生效」要求数据也一样落项目内 —— 换个项目就换一份库，
 * 不与任何项目外的库耦合。
 *
 * 仍然兼容：如果确实想复用某个既有共享库（例如历史迁移），
 * 在 `.dsh-bus.json` 里写 `transport.sqlitePath` 指过去即可，表结构自带前缀
 * `dsh_bus_*`，不会与人家的表冲突。
 *
 * 迁移 SQL 见 migrations/001_dsh_bus.sql（与 BUS_DDL 逐字一致）。
 * 使用 node:sqlite（Node 22.5+ 内置，无需原生编译），没有则抛 E_TRANSPORT 由上层降级。
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BusError, type BusMessage } from '../types.ts'
import { BUS_DDL, type ListQuery, type Transport, type UnreadCount } from './transport.ts'

interface Row {
  [key: string]: unknown
}

/** node:sqlite 只接受 null，不接受 undefined —— 统一在绑定点归一。 */
function nullable(value: string | undefined): string | null {
  return value === undefined ? null : value
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value))
  } catch {
    return undefined
  }
}

function toMessage(row: Row): BusMessage {
  return {
    id: String(row['id']),
    ts: Number(row['ts']),
    kind: String(row['kind']) as BusMessage['kind'],
    fromId: String(row['from_id']),
    fromName: row['from_name'] == null ? undefined : String(row['from_name']),
    fromSource: String(row['from_source']) as BusMessage['fromSource'],
    toId: String(row['to_id']),
    toName: row['to_name'] == null ? undefined : String(row['to_name']),
    replyTo: row['reply_to'] == null ? undefined : String(row['reply_to']),
    broadcastId: row['broadcast_id'] == null ? undefined : String(row['broadcast_id']),
    payload: {
      text: String(row['payload_text'] ?? ''),
      data: row['payload_data'] == null ? undefined : safeJson(row['payload_data']),
    },
    meta: row['meta_json'] == null ? undefined : safeJson(row['meta_json']),
  }
}

export interface SqliteTransportOptions {
  /** 完整库文件路径；相对路径按 projectRoot 解析。 */
  path: string
  /** 供错误信息显示的来源说明。 */
  projectRoot?: string
}

export class SqliteTransport implements Transport {
  readonly kind = 'sqlite'
  private db: any
  private readonly dbPath: string
  private closed = false

  constructor(options: SqliteTransportOptions) {
    this.dbPath = options.path
  }

  async init(): Promise<void> {
    let DatabaseSync: any
    try {
      // 动态取，避免在不支持的 node 上静态解析失败（Node 22.5 之前没有这个模块）。
      const req = createRequire(import.meta.url)
      const mod = req('node:sqlite')
      DatabaseSync = mod.DatabaseSync
    } catch (error) {
      throw new BusError('E_TRANSPORT', `node:sqlite 不可用（需要 Node >= 22.5）：${String(error)}`, {
        path: this.dbPath,
      })
    }
    try {
      // 目录可能还不存在（项目内首次启用）
      mkdirSync(dirname(this.dbPath), { recursive: true })
      this.db = new DatabaseSync(this.dbPath)
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA busy_timeout = 5000;')
      this.db.exec(BUS_DDL)
    } catch (error) {
      throw new BusError('E_TRANSPORT', `打开/初始化 sqlite 失败：${String(error)}`, { path: this.dbPath })
    }
  }

  async append(message: BusMessage): Promise<BusMessage> {
    const [written] = await this.appendMany([message])
    return written
  }

  async appendMany(messages: BusMessage[]): Promise<BusMessage[]> {
    this.assertOpen()
    if (messages.length === 0) return []
    const insert = this.db.prepare(
      `INSERT INTO dsh_bus_messages
        (id, ts, kind, from_id, from_name, from_source, to_id, to_name, reply_to, broadcast_id, payload_text, payload_data, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const receipt = this.db.prepare(
      `INSERT OR REPLACE INTO dsh_bus_receipts (message_id, target, ts, read_at, delivered, detail) VALUES (?,?,?,?,?,?)`,
    )
    try {
      this.db.exec('BEGIN IMMEDIATE')
      for (const message of messages) {
        insert.run(
          message.id,
          message.ts,
          message.kind,
          message.fromId,
          nullable(message.fromName),
          message.fromSource ?? 'unknown',
          message.toId,
          nullable(message.toName),
          nullable(message.replyTo),
          nullable(message.broadcastId),
          message.payload.text,
          nullable(message.payload.data === undefined ? undefined : JSON.stringify(message.payload.data)),
          nullable(message.meta === undefined ? undefined : JSON.stringify(message.meta)),
        )
        receipt.run(message.id, message.toId, message.ts, null, null, null)
        if (message.fromId !== message.toId) {
          // 发送方自己也有一份「已读」占位，避免自己的消息算成自己的未读。
          receipt.run(message.id, message.fromId, message.ts, message.ts, 'sender', null)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 事务可能已回滚 */
      }
      throw new BusError('E_TRANSPORT', `写消息失败：${String(error)}`)
    }
    return messages
  }

  async list(query: ListQuery = {}): Promise<BusMessage[]> {
    this.assertOpen()
    const where: string[] = []
    const params: unknown[] = []
    if (query.to !== undefined && query.to !== '*') {
      where.push('m.to_id = ?')
      params.push(query.to)
    }
    if (query.from !== undefined) {
      where.push('m.from_id = ?')
      params.push(query.from)
    }
    if (query.involving !== undefined) {
      where.push('(m.to_id = ? OR m.from_id = ?)')
      params.push(query.involving, query.involving)
    }
    if (query.unreadOnly === true) {
      where.push('EXISTS (SELECT 1 FROM dsh_bus_receipts r WHERE r.message_id = m.id AND r.target = m.to_id AND r.read_at IS NULL)')
    }
    if (query.sinceTs !== undefined) {
      where.push('m.ts > ?')
      params.push(query.sinceTs)
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000))
    const sql =
      'SELECT m.* FROM dsh_bus_messages m' +
      (where.length === 0 ? '' : ' WHERE ' + where.join(' AND ')) +
      ' ORDER BY m.ts ASC, m.id ASC LIMIT ' +
      String(limit)
    const rows: Row[] = this.db.prepare(sql).all(...params)
    return rows.map(toMessage)
  }

  async markRead(target: string, ids: string[]): Promise<number> {
    this.assertOpen()
    if (ids.length === 0) return 0
    const now = Date.now()
    const statement = this.db.prepare(
      `UPDATE dsh_bus_receipts SET read_at = ? WHERE target = ? AND message_id = ? AND read_at IS NULL`,
    )
    let changed = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) {
        const result = statement.run(now, target, id)
        changed += Number(result?.changes ?? 0)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw new BusError('E_TRANSPORT', `标记已读失败：${String(error)}`)
    }
    return changed
  }

  async unread(targets: string[]): Promise<UnreadCount[]> {
    this.assertOpen()
    if (targets.length === 0) return []
    const statement = this.db.prepare(
      `SELECT COUNT(*) AS c FROM dsh_bus_receipts r
       JOIN dsh_bus_messages m ON m.id = r.message_id
       WHERE r.target = ? AND r.read_at IS NULL AND m.from_id <> r.target`,
    )
    return targets.map((target) => ({ target, count: Number(statement.get(target)?.c ?? 0) }))
  }

  async get(id: string): Promise<BusMessage | undefined> {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM dsh_bus_messages WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : toMessage(row)
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.db?.close?.()
    } catch {
      /* 关闭失败不影响宿主 */
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new BusError('E_TRANSPORT', 'sqlite transport 已关闭')
    if (this.db === undefined) throw new BusError('E_TRANSPORT', 'sqlite transport 未初始化（先 await init()）')
  }
}

/** 默认库路径：**项目内** `<projectRoot>/.dsh-bus/bus.db`。 */
export function defaultSqlitePath(projectRoot: string): string {
  return join(projectRoot, '.dsh-bus', 'bus.db')
}
