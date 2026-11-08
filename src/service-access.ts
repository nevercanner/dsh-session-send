/**
 * 宿主服务访问的小工具。
 *
 * cordis 的 ctx 有两种取服务方式：`ctx.get('name')` 与 `ctx.name`（属性 getter，
 * 未 inject 时读取会 throw）。两者在不同宿主版本/不同调用点都有出现，
 * 这里统一成「先 get，再属性，失败返回 undefined」，任何地方都不因为一个可选服务缺席而抛。
 */
export function resolveService<T = any>(ctx: any, name: string): T | undefined {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet as T
  } catch {
    /* 落到属性访问 */
  }
  try {
    const viaProperty = ctx[name]
    return (viaProperty as T) ?? undefined
  } catch {
    return undefined
  }
}
