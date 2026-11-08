/**
 * 工具返回值归一：把任意值变成**无损 JSON**。
 *
 * ── 为什么需要这个（真实事故）──────────────────────────────────
 * 宿主的 `snapshotJsonValue()` 只接受：
 *   · plain object（原型必须是 Object.prototype）
 *   · plain array
 *   · string / number / boolean / null
 * 并且**拒绝 `undefined`**、Map/Set、Date、BigInt、类实例、循环引用。
 *
 * 违反时宿主抛：
 *   `tool "xxx" returned invalid output: value is not lossless JSON`
 * 整次工具调用失败 —— 即使业务逻辑完全正确。
 *
 * 我们的 `AgentEntry` 里 `workspace` / `status` / `teamId` / `role` 都是可选的，
 * 序列化后就是 `undefined`，直接踩中这条规则。
 *
 * ── 处理规则 ───────────────────────────────────────────────────
 *   undefined          → 该字段**整体省略**（不是写成 null，避免污染语义）
 *   null               → 保留
 *   string/number/bool → 保留（NaN/Infinity 转 null，因为 JSON 不支持）
 *   bigint             → 转字符串（保精度，不丢信息）
 *   Date               → ISO 字符串
 *   Map                → 普通对象
 *   Set                → 数组
 *   Array              → 逐项归一，undefined 项转 null（数组不能跳位）
 *   普通对象           → 逐键归一，跳过 undefined
 *   其它（函数/类实例）→ 省略或转字符串
 *   循环引用           → 该分支省略（不抛错）
 *
 * 这不是「随手 stringify」：我们主动构造一个合法的、语义等价的结构，
 * 而不是让宿主在序列化阶段失败。
 */

/** 是否是普通对象（原型为 Object.prototype 或 null）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 把任意值归一成无损 JSON。
 *
 * @param value 待归一的任意值
 * @param seen  循环引用检测用（内部递归传入，外部不要传）
 * @returns 一定可以被宿主无损序列化的值；`undefined` 表示该值应被省略
 */
export function toLosslessJson(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined) return undefined
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    // JSON 不支持 NaN / Infinity
    return Number.isFinite(value as number) ? value : null
  }
  if (type === 'bigint') {
    // 保精度：转字符串而不是 Number（后者会丢精度）
    return (value as bigint).toString()
  }
  if (type === 'function' || type === 'symbol') return undefined

  const object = value as object

  // 循环引用：该分支省略，不抛错
  if (seen.has(object)) return undefined
  seen.add(object)

  try {
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? null : object.toISOString()
    }
    if (object instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of object.entries()) {
        const normalized = toLosslessJson(entry, seen)
        if (normalized !== undefined) out[String(key)] = normalized
      }
      return out
    }
    if (object instanceof Set) {
      const out: unknown[] = []
      for (const entry of object.values()) {
        const normalized = toLosslessJson(entry, seen)
        out.push(normalized === undefined ? null : normalized)
      }
      return out
    }
    if (Array.isArray(object)) {
      // 数组不能跳位：undefined 项转 null
      return object.map((entry) => {
        const normalized = toLosslessJson(entry, seen)
        return normalized === undefined ? null : normalized
      })
    }
    if (isPlainObject(object)) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(object)) {
        const normalized = toLosslessJson(entry, seen)
        // undefined 字段整体省略
        if (normalized !== undefined) out[key] = normalized
      }
      return out
    }
    // 类实例等：退化为字符串，保证不丢整条记录
    return String(object)
  } finally {
    seen.delete(object)
  }
}

/**
 * 把工具返回值归一成无损 JSON 对象。
 * 工具 handler 返回前统一过一遍，避免宿主在序列化阶段整单失败。
 */
export function asToolResult(value: unknown): Record<string, unknown> {
  const normalized = toLosslessJson(value)
  if (normalized === undefined) return {}
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    return { value: normalized }
  }
  return normalized as Record<string, unknown>
}
