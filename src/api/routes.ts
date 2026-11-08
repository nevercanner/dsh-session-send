/**
 * HTTP 路由：给侧栏 UI 用。
 *
 * 挂在宿主 `ctx.webServer`（见 cordis_inspect `webServer.register`），全部为已鉴权路由：
 * 裸 WebServer 路由不继承 Connection 的鉴权栅栏，所以这里自己做一次
 * `ctx.connection.requestRejection(req)`（与 dsh-agent-teams 的 authenticatedWebRoutes 同款做法）。
 *
 * 路由表：
 *   GET  /plugins/dsh-session-send/status      装配/开关/兼容性诊断（含未开启原因）
 *   GET  /plugins/dsh-session-send/agents      可寻址 agent/session 列表（含未读数）
 *   GET  /plugins/dsh-session-send/messages    消息流（?owner=&limit=&since=&unread=1）
 *   POST /plugins/dsh-session-send/send        发消息 { from, to, kind, payload, replyTo? }
 *   POST /plugins/dsh-session-send/read        标记已读 { target, ids }
 *   GET  /plugins/dsh-session-send/project     某个项目此刻的开关状态（?project=<路径>）
 *   POST /plugins/dsh-session-send/project     切换开关 { project, enabled? }（省略 enabled = 翻转）
 *
 * 项目根的来源：请求体/查询里的 `project` 由 **Client 从宿主 Workspace 快照**取得，
 * 不是任意字符串 —— 但我们仍在服务端做「必须存在且是目录」的校验，
 * 避免一个手写请求去改无关目录。
 *
 * 所有响应都是 JSON，错误统一 { error: { code, message, detail? } }，HTTP 状态按码映射。
 */
import type { BusService } from './service.ts'
import { BusError, type BusKind, type SendRequest } from '../types.ts'
import { resolveService } from '../service-access.ts'
import type { ProjectControl } from './control.ts'
import { normalizeProjectRoot } from './control.ts'
import { existsSync, statSync } from 'node:fs'

export interface RouteDeps {
  bus: BusService
  /** 项目开关写入口（唯一会写文件的地方）。 */
  control: ProjectControl
  /** 宿主 ctx，用于取 connection / logger。 */
  ctx: any
  logger?: { warn?(message: string): void }
}

interface RouteRequest {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 鉴权栅栏：与 dsh-agent-teams/lib/web-routes.js 的 authenticatedWebRoutes 行为一致。 */
function rejectionOf(ctx: any, req: RouteRequest): number | undefined {
  try {
    const connection = resolveService<any>(ctx, 'connection')
    if (connection === undefined) return 503
    const rejection = connection.requestRejection(req)
    return rejection === undefined ? undefined : rejection
  } catch {
    return 503
  }
}

function sendJson(res: RouteResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function errorStatus(code: string): number {
  switch (code) {
    case 'E_DISABLED':
      return 409
    case 'E_TARGET_NOT_FOUND':
      return 404
    case 'E_AMBIGUOUS_TARGET':
      return 409
    case 'E_BROADCAST_DISABLED':
      return 403
    case 'E_BROADCAST_EMPTY':
      return 409
    case 'E_PAYLOAD_TOO_LARGE':
      return 413
    case 'E_PAYLOAD_EMPTY':
    case 'E_REPLY_TARGET_MISSING':
    case 'E_SELF_SEND':
      return 400
    case 'E_TRANSPORT':
      return 500
    default:
      return 500
  }
}

async function readJsonBody(req: any, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      if (error !== undefined) {
        req.resume?.()
        reject(error)
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: Buffer): void => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > maxBytes) finish(new Error('request body is too large'))
      else chunks.push(part)
    }
    const onEnd = (): void => finish()
    const onError = (): void => finish(new Error('invalid request body'))
    req.on?.('data', onData)
    req.once?.('end', onEnd)
    req.once?.('error', onError)
  })
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be an object')
  }
  return parsed as Record<string, unknown>
}

/** 项目根校验：归一后必须是**已存在的目录**。挡住手写请求去改无关路径。 */
function requireProjectDir(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new BusError('E_TARGET_NOT_FOUND', '缺少 project（项目根绝对路径）')
  }
  let root: string
  try {
    root = normalizeProjectRoot(input)
  } catch {
    throw new BusError('E_TARGET_NOT_FOUND', `project 不是合法路径：${input}`)
  }
  if (!existsSync(root)) throw new BusError('E_TARGET_NOT_FOUND', `项目目录不存在：${root}`, { projectRoot: root })
  try {
    if (!statSync(root).isDirectory()) {
      throw new BusError('E_TARGET_NOT_FOUND', `project 不是目录：${root}`, { projectRoot: root })
    }
  } catch (error) {
    if (error instanceof BusError) throw error
    throw new BusError('E_TARGET_NOT_FOUND', `无法访问项目目录：${root}`, { projectRoot: root })
  }
  return root
}

export function registerBusRoutes(deps: RouteDeps): Array<{ path: string; dispose: () => void }> {
  const { bus, control, ctx } = deps
  const webServer = resolveService<any>(ctx, 'webServer') ?? resolveService<any>(ctx, 'httpServer')
  if (webServer === undefined) return []

  const register = (path: string, handler: (req: any, res: any) => Promise<void>): (() => void) => {
    try {
      return webServer.register({
        kind: 'exact',
        path,
        handler: async (req: any, res: any) => {
          const rejection = rejectionOf(ctx, req)
          if (rejection !== undefined) {
            sendJson(res, rejection, { error: { code: 'E_AUTH', message: rejection === 503 ? 'authentication unavailable' : 'unauthorized' } })
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            const busError = error instanceof BusError ? error : undefined
            if (busError === undefined) deps.logger?.warn?.(`[dsh-session-send] route ${path} 失败：${String(error)}`)
            sendJson(res, busError === undefined ? 500 : errorStatus(busError.code), {
              error:
                busError === undefined
                  ? { code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) }
                  : busError.toJSON(),
            })
          }
        },
      })
    } catch (error) {
      // 宿主对 exact 路由去重：同名路径再注册会抛 duplicate。
      // 这通常意味着上一代 entry 的路由还没摘干净（HMR / 重载竞态）。
      // 这里**不能让一条失败阻断后面的注册** —— 否则后面的路由（例如 /project）永远挂不上，
      // 而前一条已经成功，症状会变成「路由表缺一截」这种极难排查的形态。
      deps.logger?.warn?.(
        `[dsh-session-send] 注册路由 ${path} 失败（可能上一代未摘除，跳过）：${String(error)}`,
      )
      return () => {}
    }
  }

  /** 已注册路由登记表：path 与 dispose 一一对应，卸载时按 path 精确摘除。 */
  const registered: Array<{ path: string; dispose: () => void }> = []
  const add = (path: string, handler: (req: any, res: any) => Promise<void>): void => {
    registered.push({ path, dispose: register(path, handler) })
  }

  add('/plugins/dsh-session-send/status', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'E_METHOD', message: 'GET only' } })
    // 用异步版：先让 dsh-team adapter 完成模块加载，adapter.mode 才是真实值
    sendJson(res, 200, { status: await bus.statusAsync() })
  })

  add('/plugins/dsh-session-send/agents', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'E_METHOD', message: 'GET only' } })
    const url = new URL(String(req.url ?? '/'), 'http://x')
    const owner = url.searchParams.get('owner')?.trim() ?? ''
    const snapshot = await bus.snapshot(owner, 0)
    sendJson(res, 200, {
      enabled: snapshot.enabled,
      owner,
      agents: snapshot.agents,
      unread: snapshot.unread,
      sources: snapshot.sources,
      adapter: snapshot.adapter,
    })
  })

  add('/plugins/dsh-session-send/messages', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'E_METHOD', message: 'GET only' } })
    const url = new URL(String(req.url ?? '/'), 'http://x')
    const owner = url.searchParams.get('owner')?.trim() ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const since = url.searchParams.get('since')
    const unread = url.searchParams.get('unread') === '1'
    const messages = await bus.history({
      involving: owner === '' ? undefined : owner,
      sinceTs: since === null ? undefined : Number(since),
      unreadOnly: unread,
      limit: Number.isFinite(limit) ? limit : 100,
    })
    sendJson(res, 200, { messages })
  })

  add('/plugins/dsh-session-send/send', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'E_METHOD', message: 'POST only' } })
    const body = await readJsonBody(req)
    const request = toSendRequest(body)
    const receipt = await bus.send(request)
    sendJson(res, 200, { receipt })
  })

  add('/plugins/dsh-session-send/read', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'E_METHOD', message: 'POST only' } })
    const body = await readJsonBody(req)
    const target = typeof body['target'] === 'string' ? body['target'] : ''
    const ids = Array.isArray(body['ids']) ? body['ids'].filter((id): id is string => typeof id === 'string') : []
    if (target === '') throw new BusError('E_TARGET_NOT_FOUND', '缺少 target')
    const changed = await bus.markRead(target, ids)
    sendJson(res, 200, { changed })
  })

  // ── 项目开关：状态读取 ──
  //
  // 新增 `/whoami`：只带 sessionId，host 侧自己查项目根与开关状态。
  // 为什么需要它：客户端 slot 组件拿到的宿主注入 props 不稳定（同一个菜单项
  // 在不同会话里有时渲染、有时不渲染），不能把「解析项目根」这种关键逻辑
  // 放在浏览器侧。host 有 sessionQuery / agents，是唯一可靠的位置。
  add('/plugins/dsh-session-send/whoami', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'E_METHOD', message: 'GET only' } })
    const url = new URL(String(req.url ?? '/'), 'http://x')
    const sessionId = String(url.searchParams.get('session') ?? '').trim()
    if (sessionId === '') throw new BusError('E_TARGET_NOT_FOUND', '缺少 session 参数')

    const sessionQuery = resolveService<any>(ctx, 'sessionQuery')
    const agents = resolveService<any>(ctx, 'agents')
    let cwd: string | undefined

    // ① 活 Agent 直接拿 cwd
    try {
      const live = agents?.get?.(sessionId)
      const value = live?.session?.header?.cwd
      if (typeof value === 'string' && value.trim() !== '') cwd = value
    } catch { /* 继续 */ }

    // ② 磁盘记录（未激活的会话）
    if (cwd === undefined && typeof sessionQuery?.listSessions === 'function') {
      try {
        const all = await sessionQuery.listSessions()
        const rec = all.find((item: any) => String((item?.header ?? item)?.id ?? '') === sessionId)
        const value = (rec?.header ?? rec)?.cwd
        if (typeof value === 'string' && value.trim() !== '') cwd = value
      } catch { /* 继续 */ }
    }

    if (cwd === undefined) {
      sendJson(res, 200, { sessionId, projectRoot: undefined, project: undefined, reason: '找不到该会话的项目目录' })
      return
    }
    const state = await control.status(cwd)
    sendJson(res, 200, { sessionId, projectRoot: cwd, project: state })
  })

  add('/plugins/dsh-session-send/project', async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(String(req.url ?? '/'), 'http://x')
      const projectRoot = requireProjectDir(url.searchParams.get('project'))
      const state = await control.status(projectRoot)
      sendJson(res, 200, { project: state })
      return
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const projectRoot = requireProjectDir(body['project'])
      const explicit = body['enabled']
      let state
      if (typeof explicit === 'boolean') {
        state = await control.set(projectRoot, explicit)
      } else {
        // 省略 enabled = 翻转（菜单点一下就是这一步）
        state = await control.toggle(projectRoot)
      }
      // 切换后如果切的是当前 runtime 所在项目，service 已经热换了；
      // 不是当前项目则顺带返回一次最新状态。
      sendJson(res, 200, { project: state, status: bus.status() })
      return
    }
    sendJson(res, 405, { error: { code: 'E_METHOD', message: 'GET or POST only' } })
  })

  return registered
}

/** 把 HTTP/工具入参整形为 SendRequest（两处共用一份，避免语义漂移）。 */
export function toSendRequest(body: Record<string, unknown>): SendRequest {
  const from = typeof body['from'] === 'string' ? body['from'] : ''
  const to = typeof body['to'] === 'string' ? body['to'] : ''
  const kindRaw = typeof body['kind'] === 'string' ? body['kind'] : 'text'
  const kinds: BusKind[] = ['text', 'request', 'response', 'event']
  const kind = (kinds as string[]).includes(kindRaw) ? (kindRaw as BusKind) : 'text'
  const payloadRaw = body['payload']
  const payload =
    typeof payloadRaw === 'string'
      ? { text: payloadRaw }
      : payloadRaw !== null && typeof payloadRaw === 'object'
        ? {
            text: typeof (payloadRaw as any).text === 'string' ? String((payloadRaw as any).text) : '',
            data: (payloadRaw as any).data,
          }
        : { text: '' }
  return {
    from,
    to,
    kind,
    payload,
    replyTo: typeof body['replyTo'] === 'string' && body['replyTo'].trim() !== '' ? body['replyTo'].trim() : undefined,
    meta:
      body['meta'] !== null && typeof body['meta'] === 'object' && !Array.isArray(body['meta'])
        ? (body['meta'] as Record<string, unknown>)
        : undefined,
  }
}
