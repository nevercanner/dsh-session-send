/**
 * 构建脚本：把 src/ 的 TypeScript 用 **Node 内置的 stripTypeScriptTypes** 转成 JS。
 *
 * 为什么不用 tsc / esbuild：
 *  - 本机 profile 里没有装 TypeScript 编译器（只有运行时包），而插件的硬要求是
 *    「装上就能跑」，不能在安装路径上依赖一个可能缺席的 devDependency；
 *  - Node >= 22.6 自带 `node:module.stripTypeScriptTypes`，正是为「发 TS 源码、由 Node
 *    自己剥类型」准备的，行为与 `--experimental-strip-types` 一致。
 *
 * 产物：
 *   lib/index.js        ← src/index.ts（逐文件转译，保持相对 import 结构）
 *   lib/client.js       ← src/ui/client.js（原样复制；Client 半是纯 JS）
 *   lib/**\/*.js        ← 其余 src 子模块
 *   types/index.d.ts    ← 极简公开面声明
 *
 * 注意（Windows 沙箱实测）：本机 shell 在某些目录下 `mkdir` 会被拒（EPERM），
 * 因此这里把建目录做成「尽力而为」——目录已存在时 writeFile 完全够用。
 * 转译只剥类型、不做类型检查；类型检查请跑 `npm run typecheck`。
 */
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

/** 建目录但容忍 EPERM（目录可能已由编辑器/工具预建）。 */
async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error
  }
}

async function walk(dir) {
  const output = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) output.push(...(await walk(full)))
    else output.push(full)
  }
  return output
}

/** `.ts` → `.js` 相对 import 改写：产物里必须指向真实存在的文件。 */
function rewriteImports(code) {
  return code
    .replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3')
    .replace(/(export\s+\*\s+from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
}

async function main() {
  if (!existsSync(srcDir)) throw new Error(`缺少 src 目录：${srcDir}`)
  await ensureDir(outDir)

  const files = await walk(srcDir)
  let converted = 0
  let copied = 0
  for (const file of files) {
    const rel = relative(srcDir, file)
    if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      const source = await readFile(file, 'utf8')
      let code
      try {
        code = stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: file })
      } catch (error) {
        throw new Error(`转译失败 ${rel}: ${String(error)}`)
      }
      const target = join(outDir, rel.replace(/\.ts$/, '.js'))
      await ensureDir(dirname(target))
      await writeFile(target, rewriteImports(code), 'utf8')
      converted += 1
    } else if (file.endsWith('.js')) {
      const target = join(outDir, rel)
      await ensureDir(dirname(target))
      await copyFile(file, target)
      copied += 1
      if (rel.endsWith('client.js')) {
        await copyFile(file, join(outDir, 'client.js'))
        copied += 1
      }
    }
  }

  // 极简 .d.ts：只声明公开面，避免外部 TS 引用时报「找不到类型」
  const typesDir = join(root, 'types')
  await ensureDir(typesDir)
  await writeFile(
    join(typesDir, 'index.d.ts'),
    `export declare const name: string
export declare const description: string
export declare const Config: unknown
export declare function apply(ctx: any, config?: Record<string, unknown>): Promise<void>
export type BusKind = 'text' | 'request' | 'response' | 'event'
export interface BusPayload { text: string; data?: unknown }
export interface SendRequest { from: string; to: string; kind?: BusKind; payload: BusPayload | string; replyTo?: string; meta?: Record<string, unknown> }
export interface BusMessage { id: string; ts: number; kind: BusKind; fromId: string; fromName?: string; toId: string; toName?: string; replyTo?: string; payload: BusPayload; broadcastId?: string }
export interface SendReceipt { ok: true; messages: BusMessage[]; deliveries: Array<{ to: string; messageId: string; mode: string; detail?: string }> }
`,
    'utf8',
  )

  console.log(`[dsh-session-send] build 完成：${converted} 个 TS 模块 → lib/，${copied} 个 JS 复制`)
}

await main()
