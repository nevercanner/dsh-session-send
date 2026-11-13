/**
 * 公共类型。schema.ts / transport / registry / router / api 全部只依赖这里，
 * 保证任何一层都能在不认识其它层实现的情况下被替换。
 *
 * 边界：本插件是 **DSH** 插件。这里的每个类型都只描述 DSH 侧的东西；
 * 不出现 OpenClaw 的配置文件、进程或路径概念。参考的是 OpenClaw `session send`
 * 的**消息语义**（from/to/kind/payload/replyTo），不是它的数据面。
 */

/** 消息种类，与 openclaw `session send` 的会话消息语义对齐。 */
export type BusKind = 'text' | 'request' | 'response' | 'event'

export type TransportKind = 'sqlite' | 'file' | 'in-process'

/** 注册表来源：只允许 DSH 宿主内的两种。 */
export type RegistrySource = 'dsh-team' | 'dsh-sessions'

/** 一条总线消息。字段名刻意贴近 openclaw 的会话消息：from / to / kind / payload / replyTo。 */
export interface BusMessage {
  id: string
  ts: number
  kind: BusKind
  /** 发送方 id（agent id 或 session id，取决于 fromSource）。 */
  fromId: string
  fromName?: string
  fromSource: RegistrySource | 'unknown'
  /** 接收方 id；广播时每个目标各一条，具体目标写在这里。 */
  toId: string
  toName?: string
  /** 请求-响应关联；response 消息必须带 replyTo 指回原消息的 id。 */
  replyTo?: string
  payload: BusPayload
  /** 广播批次的关联 id；同一批广播的多条消息共享它。 */
  broadcastId?: string
  meta?: Record<string, unknown>
}

export interface BusPayload {
  text: string
  data?: unknown
}

/** 发送入参（对齐 openclaw session send 的语义；参数名差异见 router 顶部注释）。 */
export interface SendRequest {
  from: string
  to: string
  kind?: BusKind
  payload: BusPayload | string
  replyTo?: string
  meta?: Record<string, unknown>
}

export interface SendReceipt {
  ok: true
  /** 实际写入的消息（广播时为多条）。 */
  messages: BusMessage[]
  /** 每个目标的投递状态。 */
  deliveries: DeliveryResult[]
}

export interface DeliveryResult {
  to: string
  toName?: string
  toSource?: RegistrySource | 'unknown'
  messageId: string
  /** durable = 仅落库；woken = 已唤醒 dsh-team 成员；steered = 已注入活动队长/成员；queued = 已入队。 */
  mode: 'durable' | 'woken' | 'steered' | 'queued' | 'failed'
  detail?: string
}

/** 注册表条目：一个可寻址的 agent / session。 */
export interface AgentEntry {
  id: string
  name: string
  kind: 'agent' | 'session'
  source: RegistrySource
  workspace?: string
  status?: string
  teamId?: string
  role?: 'lead' | 'teammate'
}

/**
 * BusConfig：项目级配置（`<workspace>/.dsh-bus.json`）的形状。
 * 没有 `root` 字段 —— 项目根由宿主（workspace）决定，不由配置自述。
 */
export interface BusConfig {
  enabled: boolean
  scope: 'project'
  transport: {
    kind: TransportKind
    sqlitePath?: string
    fileDir?: string
  }
  registry: {
    sources: RegistrySource[]
    stateDir: string
    /**
     * 是否要求会话「报名后才参与总线」。
     *
     * - `true`（默认）：只有调过 `dsh_bus_register` 的会话才出现在列表里、
     *   才能被寻址、才会被投递。**未报名的会话完全不受打扰。**
     * - `false`：项目里所有会话都可寻址（小项目、会话少时更方便，
     *   代价是无关会话会出现在列表里）。
     *
     * 默认 `true` 的理由：实测一个项目 121 个会话里只有 7 个真正参与，
     * 全接入会让列表被无关会话淹没，也制造误发机会。
     */
    requireRegistration: boolean
  }
  router: {
    allowBroadcast: boolean
    maxPayloadChars: number
    dshTeam: {
      enabled: boolean
      target: 'auto' | 'service' | 'mailbox'
    }
    /**
     * 重发机制：接收方会话因模型未配置等原因未能真正处理消息时，
     * 等它被重新激活（模型配好）后自动把未处理的消息重新投递。
     * 默认关闭 —— 这是主动动作，不应默认开启。
     */
    redeliver: {
      /** 总开关。默认 false：不自动重发未处理消息。 */
      enabled: boolean
      /** 每条未处理消息最多重发次数（防风暴）。 */
      maxAttempts: number
    }
  }
  /**
   * 会话显示名映射：session id → 可读名（如 "跑章选手" / "门禁"）。
   *
   * 为什么需要：宿主的会话 `title` 常常是空的（异步生成，历史会话多半没有），
   * 列表里只能看到 uuid，无法判断哪条是哪条工作线。
   * 这里让使用者自己起名，不改宿主数据，只影响本插件的显示与 `to` 解析。
   */
  labels?: Record<string, string>
  ui: {
    entry: boolean
    pollMs: number
  }
}

/** 总线错误码：目标不存在必须显式报错，绝不静默丢弃。 */
export type BusErrorCode =
  | 'E_DISABLED'
  | 'E_TARGET_NOT_FOUND'
  | 'E_AMBIGUOUS_TARGET'
  | 'E_BROADCAST_DISABLED'
  | 'E_BROADCAST_EMPTY'
  | 'E_PAYLOAD_TOO_LARGE'
  | 'E_PAYLOAD_EMPTY'
  | 'E_REPLY_TARGET_MISSING'
  | 'E_SELF_SEND'
  | 'E_TRANSPORT'

export class BusError extends Error {
  readonly code: BusErrorCode
  readonly detail?: Record<string, unknown>

  constructor(code: BusErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'BusError'
    this.code = code
    this.detail = detail
  }

  toJSON(): { code: BusErrorCode; message: string; detail?: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}
