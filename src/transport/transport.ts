/**
 * transport 层接口。
 *
 * 硬约束（架构要求，非建议）：
 *  - 只依赖 ../types.ts 与 node 内置模块；
 *  - **不 import registry / router / ui**；
 *  - 不读任何配置文件（配置由上层注入）。
 *
 * 任何实现只做「消息落库 + 按条件读出 + 标记已读」，不理解 agent、不理解路由。
 */
import type { BusMessage } from '../types.ts'

export interface ListQuery {
  /** 只看发往这个身份的（'*' 表示不过滤）。 */
  to?: string
  /** 只看这个身份发出的。 */
  from?: string
  /** 只看未读。 */
  unreadOnly?: boolean
  /** 增量游标：只取 ts > sinceTs（同 ts 用 id 破平）。 */
  sinceTs?: number
  /** 最多返回多少条（默认 200，实现可设上限）。 */
  limit?: number
  /** 会话视角：把 from/to 两侧都算进来。 */
  involving?: string
}

export interface UnreadCount {
  target: string
  count: number
}

export interface Transport {
  readonly kind: string
  /** 初始化（建表 / 建目录 / 迁移）。必须幂等。 */
  init(): Promise<void>
  /** 写一条消息。返回真正落库的记录（id/ts 由实现归一）。 */
  append(message: BusMessage): Promise<BusMessage>
  /** 批量写（广播用）；要么全成功，要么抛错。 */
  appendMany(messages: BusMessage[]): Promise<BusMessage[]>
  /** 读消息（按 ts 升序）。 */
  list(query?: ListQuery): Promise<BusMessage[]>
  /** 标记已读（按 id）。 */
  markRead(target: string, ids: string[]): Promise<number>
  /** 每个身份的未读数。 */
  unread(targets: string[]): Promise<UnreadCount[]>
  /** 取一条消息（含已读状态以外的全部字段）。 */
  get(id: string): Promise<BusMessage | undefined>
  /** 关闭资源（sqlite close / 清定时器）。 */
  dispose(): Promise<void>
}

/** 迁移 SQL 的统一入口：sqlite transport 与 ops 脚本共用同一份文本。 */
export const BUS_DDL = `
CREATE TABLE IF NOT EXISTS dsh_bus_messages (
  id            TEXT NOT NULL PRIMARY KEY,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('text','request','response','event')),
  from_id       TEXT NOT NULL,
  from_name     TEXT,
  from_source   TEXT NOT NULL DEFAULT 'unknown',
  to_id         TEXT NOT NULL,
  to_name       TEXT,
  reply_to      TEXT,
  broadcast_id  TEXT,
  payload_text  TEXT NOT NULL,
  payload_data  TEXT,
  meta_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsh_bus_messages_to_ts   ON dsh_bus_messages (to_id, ts);
CREATE INDEX IF NOT EXISTS idx_dsh_bus_messages_from_ts ON dsh_bus_messages (from_id, ts);
CREATE INDEX IF NOT EXISTS idx_dsh_bus_messages_reply   ON dsh_bus_messages (reply_to) WHERE reply_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS dsh_bus_receipts (
  message_id    TEXT NOT NULL,
  target        TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  read_at       INTEGER,
  delivered     TEXT,
  detail        TEXT,
  PRIMARY KEY (message_id, target)
);
CREATE INDEX IF NOT EXISTS idx_dsh_bus_receipts_target_unread ON dsh_bus_receipts (target, read_at);
`
