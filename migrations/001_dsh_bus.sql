-- dsh-session-send 迁移 / 初始化 SQL（与 src/transport/transport.ts 的 BUS_DDL 逐字一致）
--
-- 存储位置：**项目内** `<workspace>/.dsh-bus/bus.db`
--
-- 为什么不去 openclaw-data 的 chat_shared.db 建表（定位纠正）：
--   那是 OpenClaw ↔ DeepSeek bridge 的共享库，属于另一个宿主 / 另一个项目的运行数据。
--   本插件是 DSH 插件，「仅项目内生效」要求数据也落项目内 —— 换项目换一份库。
--   若确实要复用既有共享库，在 .dsh-bus.json 写 transport.sqlitePath 指过去即可；
--   表名自带 dsh_bus_ 前缀，不会与库里的既有表冲突。
--
-- 执行方式（任选）：
--   1. 插件首次 init() 自动执行（幂等，CREATE IF NOT EXISTS）；
--   2. 手工：sqlite3 <workspace>/.dsh-bus/bus.db < migrations/001_dsh_bus.sql

PRAGMA journal_mode = WAL;

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
