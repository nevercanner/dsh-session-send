/**
 * api 层：把 BusService 暴露成两条消费面
 *   1. 宿主工具（模型侧）：src/api/tools.ts 里注册的 `dsh_bus_send` / `dsh_bus_inbox` 等；
 *   2. HTTP 路由（UI 侧）：/plugins/dsh-session-send/*，见 ./routes.ts。
 * 外加项目开关的写入口 ./control.ts（唯一会写文件的地方）。
 *
 * 这一层不实现业务逻辑，只做「参数整形 + 错误码翻译 + 鉴权 + 开关落盘」。
 */
export { BusService, type BusRuntime, type ProjectSwitchState } from './service.ts'
export { registerBusRoutes, type RouteDeps } from './routes.ts'
export { registerBusTools, type ToolDeps } from './tools.ts'
export { createProjectControl, normalizeProjectRoot, readRawProjectConfig } from './control.ts'

