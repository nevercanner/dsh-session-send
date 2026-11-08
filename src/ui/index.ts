/**
 * ui 层说明（host 侧）：UI 的渲染在 ./client.js，这里只放 host 侧的交付与自检。
 *
 * 边界：ui 层不 import transport / registry / router 的实现，只通过
 * `/plugins/dsh-session-send/*` 这层 HTTP 面拿数据（见 src/api/routes.ts）。
 * host 半的职责仅仅是：
 *   1. 定位 client 产物（lib/client.js）；
 *   2. 暴露一份「面板可用性」判定，供 index.ts 决定是否挂入口（config.ui.entry）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BusConfig } from '../types.ts'

/** 构建产物路径：lib/client.js（package.json 的 ./client 导出指向它）。 */
export function clientEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // 源码在 src/ui/index.ts → 构建后 lib/ui/index.js；client 恒在 lib/client.js
  return join(here, '..', '..', 'client.js')
}

/** 侧栏入口是否该挂：开关打开 + 配置允许 + 产物存在。 */
export function shouldMountUi(config: BusConfig): boolean {
  if (!config.ui.entry) return false
  return existsSync(clientEntryPath())
}
