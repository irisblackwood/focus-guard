/**
 * 工具类别覆盖自检（Tool-Kind Coverage，2026-10-29）
 *
 * 背景：`core/risk.mjs` 的工具语义表是**白名单**——没登记的名字一律 `other`。
 * `other` 的后果不是"不管"，是两件很具体的事：
 *   ① 熔断期 `gateFused` 只放行 `isInvestigation`，`other` 落到 deny 分支
 *      （`dsh/preGuard.mjs:223`）——外部插件的查询工具会被当成"改动类"拒掉，理由还是错的；
 *   ② `poolOf` 把它算进**执行池**而不是侦查池（`core/progressPolicy.mjs:62`）——
 *      只读的检索动作去抢写入配额（默认 10 次/回合）。
 *
 * 装一个带十几个工具的记忆插件而不登记，就是十几个工具在熔断期被误拒、还抢写入配额。
 *
 * 本模块在会话启动时扫一遍真实工具表，把未登记的挑出来报一句。只报不改，
 * 与 `policy-audit.mjs` / `hookOrder.mjs` 同纪律：失败 sink 到 warn，不影响执法缝。
 */

import { toolKindOf } from '../core/risk.mjs'

/** 从 `ctx.tools.schemas()` 的元素里取工具名（兼容 `{name}` 与 OpenAI 的 `{function:{name}}`）。 */
export function toolNameOf(schema) {
  if (!schema || typeof schema !== 'object') return ''
  const direct = schema.name
  if (typeof direct === 'string' && direct) return direct
  const fn = schema.function
  if (fn && typeof fn === 'object' && typeof fn.name === 'string' && fn.name) return fn.name
  return ''
}

/**
 * 找出未登记语义类别的工具。
 *
 * `prefix` 默认只查 `mcp__`：内置工具漏登记是 FG 自己的欠账（该在 `adapters/dsh/tool-kinds.mjs`
 * 补齐，不是每次启动提醒用户）；外部插件才是名字不可预知、必须现场发现的那一类。
 *
 * @param {{ schemas?: any[], allow?: string[], prefix?: string }} opts
 * @returns {{ unknown: string[], scanned: number, registered: number }}
 */
export function auditToolKinds({ schemas = [], allow = [], prefix = 'mcp__' } = {}) {
  const skip = new Set((allow || []).map((s) => String(s || '').toLowerCase()))
  const wantPrefix = String(prefix || '').toLowerCase()
  const unknown = []
  let registered = 0
  for (const schema of schemas || []) {
    const name = toolNameOf(schema)
    if (!name) continue
    const key = name.toLowerCase()
    if (skip.has(key)) continue
    if (wantPrefix && !key.startsWith(wantPrefix)) continue
    if (toolKindOf(name) === 'other') unknown.push(name)
    else registered += 1
  }
  unknown.sort()
  return { unknown, scanned: registered + unknown.length, registered }
}

/** 一句话结论（给 warn 用）。无未登记工具时返回空串——调用方据此决定要不要出声。 */
export function renderToolKindNotice({ unknown = [], scanned = 0 } = {}) {
  if (!unknown.length) return ''
  const head = unknown.slice(0, 6).join('、')
  const more = unknown.length > 6 ? ` 等 ${unknown.length} 个` : ''
  return (
    `工具类别自检：${unknown.length}/${scanned} 个 MCP 工具未登记语义类别（${head}${more}）。` +
    `未登记=other：熔断期会被误拒，且占执行池而非侦查池。` +
    `到 adapters/dsh/tool-kinds.mjs 用 registerToolKind 登记。`
  )
}
