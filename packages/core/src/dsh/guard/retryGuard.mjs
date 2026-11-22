/**
 * 重复命令闸（2026-11-22）
 *
 * 病根：模型把工具返回的 `[exit code: 1]` 当环境故障，原样再发一次同命令，白烧一步的钱。
 * FG 此前只在"被 deny"上做重复提醒（重复被拦改写），**失败重试**这条路没人管。
 *
 * 规则：同一会话内，同一 `tool + 参数哈希` 连续失败 ≥2 次后，第 3 次原样重试直接拒绝，
 * 理由要求"先读错误再换法"。不做启发式猜意图，只认可观测事实（同参数 + 上次失败）。
 * 关：`FG_RETRY_GUARD=0`。
 */
import { createHash } from 'node:crypto'

const RETRY_OFF = process.env.FG_RETRY_GUARD === '0'
const MAX_ENTRIES = 256
const TTL_MS = 30 * 60 * 1000
const BLOCK_AT = 2

const seen = new Map()

function keyOf(exec) {
  const sid =
    (exec && ((exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.id) || exec.sessionId)) ||
    'unknown'
  const tool = String((exec && exec.name) || '')
  const args = stable(exec && exec.arguments)
  return `${sid}|${tool}|${hash(args)}`
}

function stable(value) {
  try {
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk)
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]))
      }
      return v
    }
    return JSON.stringify(walk(value ?? {}))
  } catch {
    return String(value)
  }
}

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** 工具结果是否算失败：宿主形状不统一，认常见的四个字段/前缀。 */
export function resultFailed(result) {
  if (!result || typeof result !== 'object') return false
  if (result.isError === true || result.error) return true
  if (result.status === 'error' || result.ok === false) return true
  const text = typeof result.text === 'string' ? result.text : ''
  return /^(?:Error|错误)[:：\s]/.test(text.trim())
}

/** 记一次结果；失败累加，成功清零。 */
export function recordToolResult(exec, result) {
  if (RETRY_OFF) return
  const key = keyOf(exec)
  const now = Date.now()
  const cur = seen.get(key)
  if (!resultFailed(result)) {
    seen.delete(key)
    return
  }
  const next = { fails: (cur && cur.fails) || 0, lastAt: now }
  next.fails += 1
  if (!seen.has(key) && seen.size >= MAX_ENTRIES) seen.delete(seen.keys().next().value)
  seen.set(key, next)
}

/** 该调用是否已连续失败到阈值。 */
export function sameCommandFailed(exec) {
  if (RETRY_OFF) return 0
  const entry = seen.get(keyOf(exec))
  if (!entry) return 0
  if (Date.now() - entry.lastAt > TTL_MS) {
    seen.delete(keyOf(exec))
    return 0
  }
  return entry.fails >= BLOCK_AT ? entry.fails : 0
}

/** 测试钩子。 */
export function resetRetryGuard() {
  seen.clear()
}
