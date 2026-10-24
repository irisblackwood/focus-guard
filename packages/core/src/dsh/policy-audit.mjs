/**
 * 策略可达性自检（Policy Self-Audit，2026-10-24）
 *
 * 背景：2026-10-22 用真实会话发现三条闸**永不触发**（`args.output_mode`/`args.pages` 在新宿主 schema 里
 * 根本不存在）。那类失效的特点是：测试全绿、线上全漏——因为测试用的是合成参数。
 *
 * 本模块把那次人工排查变成**启动自检**：
 *   ① 从判定源码里抽出引用的参数键（`args.X` / `arguments.X` / `ti.X`）；
 *   ② 与当前会话真实的工具 schema（`ctx.tools.schemas()`）求差；
 *   ③ 只报警（warn + 审计行），**不改变任何判定**。
 *
 * 只读、幂等、失败 sink 到 warn——不影响执法缝。
 */

import { readFileSync } from 'node:fs'

const KEY_RE = /\b(?:args|arguments|ti)\.([A-Za-z_$][\w$]*)/g

/** 从源码文本里抽参数键 → 出处行号。 */
export function referencedKeysOf(sourceText, label = '') {
  const out = new Map()
  sourceText.split('\n').forEach((line, idx) => {
    if (/^\s*(\*|\/\/)/.test(line)) return // 注释不算（避免把说明文字当引用）
    for (const m of line.matchAll(KEY_RE)) {
      const key = m[1]
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(`${label}:${idx + 1}`)
    }
  })
  return out
}

/** 从 `ctx.tools.schemas()` 的结果里取参数键并集。 */
export function schemaKeysOf(schemas = []) {
  const keys = new Set()
  for (const s of schemas || []) {
    const props = (s && s.parameters && s.parameters.properties) || {}
    for (const k of Object.keys(props)) keys.add(k)
  }
  return keys
}

/**
 * 计算不可达键（引用了但真实 schema 里没有）。
 * @param {{ files: Array<{label: string, text: string}>, schemaKeys: Set<string>, ignore?: string[] }} input
 * @returns {{ ghost: Array<{key: string, sites: string[]}>, reachable: string[], scanned: number }}
 */
export function auditReachability({ files = [], schemaKeys = new Set(), ignore = [] }) {
  const skip = new Set(ignore)
  const refs = new Map()
  for (const f of files) {
    for (const [k, sites] of referencedKeysOf(f.text, f.label)) {
      const cur = refs.get(k) || []
      refs.set(k, [...cur, ...sites])
    }
  }
  const ghost = []
  const reachable = []
  for (const [key, sites] of refs) {
    if (skip.has(key)) continue
    if (schemaKeys.has(key)) reachable.push(key)
    else ghost.push({ key, sites: sites.slice(0, 5) })
  }
  ghost.sort((a, b) => a.key.localeCompare(b.key))
  reachable.sort()
  return { ghost, reachable, scanned: refs.size }
}

/**
 * 运行时入口：读判定源码 + 当前 schema，返回报告。
 * @param {{ schemas: any[], files?: string[], ignore?: string[] }} opts
 */
export function runPolicyAudit({ schemas = [], files, ignore = [] } = {}) {
  const targets = files || []
  const loaded = []
  for (const f of targets) {
    try {
      loaded.push({ label: f.split(/[\\/]/).slice(-2).join('/'), text: readFileSync(f, 'utf8') })
    } catch {
      /* 读不到就跳过（打包/裁剪环境下正常） */
    }
  }
  return auditReachability({ files: loaded, schemaKeys: schemaKeysOf(schemas), ignore })
}
