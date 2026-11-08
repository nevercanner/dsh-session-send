/**
 * router 工厂 + 门面：把 transport / registry / dsh-team adapter 注入进来。
 *
 * 装配顺序固定为 transport.init → router，保证第一条消息写入前表已存在。
 */
import type { BusConfig } from '../types.ts'
import type { Transport } from '../transport/transport.ts'
import type { Registry } from '../registry/registry.ts'
import type { DshTeamAdapter } from '../registry/dsh-team-adapter.ts'
import type { SessionPusher } from '../transport/session-push.ts'
import { DefaultRouter, type Router } from './router.ts'

export interface CreateRouterOptions {
  config: BusConfig
  transport: Transport
  registry: Registry
  /** 项目根：用于「首次投递附自我介绍」的记录位置。 */
  projectRoot?: string
  dshTeam?: DshTeamAdapter
  /** 跨会话投递器：把消息推进目标的活会话（缺它就只能落库）。 */
  sessions?: SessionPusher
  logger?: { info?(message: string): void; warn?(message: string): void }
}

export function createRouter(options: CreateRouterOptions): Router {
  return new DefaultRouter({
    config: options.config,
    transport: options.transport,
    registry: options.registry,
    projectRoot: options.projectRoot,
    dshTeam: options.dshTeam,
    sessions: options.sessions,
    logger: options.logger,
  })
}

export type { Router, BusSnapshot } from './router.ts'
export { DefaultRouter, formatContent } from './router.ts'
