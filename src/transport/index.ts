/**
 * transport 工厂：一处选择实现，上层只认 Transport 接口。
 * 任意一层可替换 —— 换 transport 只需要在这里加分支。
 *
 * 所有实现的默认落点都在**项目内**（`<projectRoot>/.dsh-bus/`），
 * 不在项目外共享任何库或目录 —— 这是「仅项目内生效」在数据面上的落实。
 */
import { join } from 'node:path'
import type { BusConfig } from '../types.ts'
import type { Transport } from './transport.ts'
import { SqliteTransport, defaultSqlitePath } from './sqlite.ts'
import { FileTransport } from './file.ts'
import { InProcessTransport } from './in-process.ts'

export interface CreateTransportOptions {
  config: BusConfig
  /** 项目根（workspace 绝对路径）。 */
  projectRoot: string
  /** 允许上层在测试里注入自定义实现（工厂函数替换策略）。 */
  override?: Transport
}

export function createTransport(options: CreateTransportOptions): Transport {
  if (options.override !== undefined) return options.override
  const { config, projectRoot } = options
  switch (config.transport.kind) {
    case 'file':
      return new FileTransport({
        dir: config.transport.fileDir ?? join(projectRoot, '.dsh-bus'),
      })
    case 'in-process':
      return new InProcessTransport()
    case 'sqlite':
    default:
      return new SqliteTransport({
        path: config.transport.sqlitePath ?? defaultSqlitePath(projectRoot),
        projectRoot,
      })
  }
}

export type { Transport, ListQuery, UnreadCount } from './transport.ts'
export { BUS_DDL } from './transport.ts'
