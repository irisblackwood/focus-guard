#!/usr/bin/env node
/**
 * FocusGuard · A/B 会话成本对照（2026-10-18）
 *
 * 从 DSH 会话记录（`$DSH_HOME/.dsh/sessions` 下的 `session.v4.jsonl.zstd`）解出结构指标：
 * 步数、工具调用分布、各类正文体量、时长；再从 FG 审计里按会话 id 取拦截数。
 *
 * ⚠ 口径说明（必须随结果一起报）：
 *   宿主这份记录**不含逐次 usage**，FG 的成本台账当前也只写进退化值（model=unknown、1 token），
 *   所以"真实 token"拿不到。下面的 token 是**按字符折算的估算**，两列口径：
 *     est4   = 字符数 / 4        （宿主估算器 CHARS_PER_TOKEN = 4）
 *     estCJK = 字符数 / 1.6      （中文正文更省字节，保守下限）
 *   结论只能用于 A/B 相对比较，不能当账单。
 *
 * 用法：
 *   node tools/bench-ab.mjs --a <sessionId|前缀> --b <sessionId|前缀>
 *   node tools/bench-ab.mjs --list                # 列出最近会话
 *   node tools/bench-ab.mjs ... --json
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const listOnly = args.includes('--list')
const pick = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}

const DSH_HOME = process.env.DSH_HOME || 'E:/DSH'
// DSH_HOME 有时候指向 `.dsh` 本身，有时候指向它的父目录——两种都要能用。
const SESSIONS = DSH_HOME.replace(/[\\/]+$/, '').endsWith('.dsh')
  ? join(DSH_HOME, 'sessions')
  : join(DSH_HOME, '.dsh', 'sessions')
const AUDIT = process.env.FG_AUDIT_FILE || join('E:/DSH', 'focus-guard-main', '.focus-guard', 'AUDIT.log')

/** zstd 多帧解压：每个 turn 是一个独立帧，单帧 API 只解第一帧。 */
function decodeSession(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    const m = buf[i] === 0x28
    const a = buf[i + 1] === 0xb5
    const b = buf[i + 2] === 0x2f
    const c = buf[i + 3] === 0xfd
    if (m && a && b && c) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function allSessions() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (e === 'session.v4.jsonl.zstd') out.push(p)
    }
  }
  walk(SESSIONS)
  return out
}

function charLen(o) {
  if (!o) return 0
  if (typeof o === 'string') return o.length
  if (Array.isArray(o)) return o.reduce((a, v) => a + charLen(v), 0)
  if (typeof o === 'object') return Object.values(o).reduce((a, v) => a + charLen(v), 0)
  return 0
}

function analyze(file) {
  const lines = decodeSession(file)
  const head = lines.find((l) => l.type === 'session') || {}
  const sessionId = head.id || file
  const model = (() => {
    const h = lines.find((l) => l.type === 'request/header')
    return (h && h.data && h.data.header && h.data.header.config && h.data.header.config.model) || 'unknown'
  })()
  const steps = lines.filter((l) => l.type === 'step/start').length
  const turns = lines.filter((l) => l.type === 'turn/start').length
  const toolCalls = new Map()
  let toolArgsChars = 0
  let systemChars = 0
  let userChars = 0
  let assistantChars = 0
  let reasoningChars = 0
  let toolResultChars = 0
  for (const l of lines) {
    const d = l.data || {}
    if (l.type === 'system/message') systemChars += charLen(d.message && d.message.content)
    if (l.type === 'user/message') userChars += charLen(d.message && d.message.content)
    if (l.type === 'assistant/message') {
      const content = (d.message && d.message.content) || []
      for (const c of content) {
        if (c.type === 'reasoning') reasoningChars += charLen(c.text)
        else if (c.type === 'text') assistantChars += charLen(c.text)
        else if (c.type === 'tool-call') {
          toolArgsChars += charLen(c.arguments)
          const name = c.name || 'unknown'
          toolCalls.set(name, (toolCalls.get(name) || 0) + 1)
        }
      }
    }
    if (l.type === 'tool/result') toolResultChars += charLen((d.message && d.message.content) || [])
  }
  const times = lines.map((l) => l.time).filter((t) => typeof t === 'number')
  const durationMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
  const chars = systemChars + userChars + assistantChars + reasoningChars + toolArgsChars + toolResultChars
  return {
    sessionId,
    model,
    turns,
    steps,
    durationMs,
    chars: { system: systemChars, user: userChars, assistant: assistantChars, reasoning: reasoningChars, toolArgs: toolArgsChars, toolResult: toolResultChars, total: chars },
    tokens: { est4: Math.round(chars / 4), estCJK: Math.round(chars / 1.6) },
    toolCalls: Object.fromEntries([...toolCalls.entries()].sort((a, b) => b[1] - a[1])),
    toolCallTotal: [...toolCalls.values()].reduce((a, b) => a + b, 0),
  }
}

const auditRows = (() => {
  try {
    return readFileSync(AUDIT, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
})()

function enforcement(sessionId) {
  const mine = auditRows.filter((r) => r.session === sessionId)
  const denies = mine.filter((r) => r.action === 'deny')
  const byTrigger = new Map()
  for (const d of denies) byTrigger.set(d.trigger || 'unspecified', (byTrigger.get(d.trigger || 'unspecified') || 0) + 1)
  return { denies: denies.length, byTrigger: Object.fromEntries(byTrigger) }
}

const files = allSessions()
if (listOnly) {
  const rows = files
    .map((f) => {
      const a = analyze(f)
      return { id: a.sessionId, start: a.turns, steps: a.steps, chars: a.chars.total }
    })
    .sort((x, y) => y.chars - x.chars)
    .slice(0, 12)
  for (const r of rows) console.log(`${r.id}  steps=${r.steps}  chars=${r.chars}`)
  process.exit(0)
}

const aWant = pick('--a')
const bWant = pick('--b')
if (!aWant || !bWant) {
  console.error('用法：node tools/bench-ab.mjs --a <sessionId> --b <sessionId>   （--list 看可选会话）')
  process.exit(2)
}
const find = (want) => files.find((f) => f.includes(want))
const fa = find(aWant)
const fb = find(bWant)
if (!fa || !fb) {
  console.error(`找不到会话：a=${aWant} b=${bWant}`)
  process.exit(2)
}

const A = { ...analyze(fa), ...enforcement((analyze(fa) || {}).sessionId) }
const B = { ...analyze(fb), ...enforcement((analyze(fb) || {}).sessionId) }
// 上面的 enforcement 需要解析后的 id，重算一次避免顺序问题
A.enforcement = enforcement(A.sessionId)
B.enforcement = enforcement(B.sessionId)

const report = {
  ts: new Date().toISOString(),
  caveat: 'token 为字符折算估算（est4=chars/4，estCJK=chars/1.6），宿主记录不含逐次 usage，不可当账单',
  a: A,
  b: B,
  delta: {
    steps: B.steps - A.steps,
    toolCalls: B.toolCallTotal - A.toolCallTotal,
    chars: B.chars.total - A.chars.total,
    tokensEst4: B.tokens.est4 - A.tokens.est4,
    denies: B.enforcement.denies - A.enforcement.denies,
    durationMs: B.durationMs - A.durationMs,
  },
  costEffectiveness: {
    a_tokensPerStep: A.steps ? Math.round(A.tokens.est4 / A.steps) : 0,
    b_tokensPerStep: B.steps ? Math.round(B.tokens.est4 / B.steps) : 0,
    a_tokensPerDeny: A.enforcement.denies ? Math.round(A.tokens.est4 / A.enforcement.denies) : null,
    b_tokensPerDeny: B.enforcement.denies ? Math.round(B.tokens.est4 / B.enforcement.denies) : null,
  },
}

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const f = (n) => new Intl.NumberFormat('en-US').format(n)
  console.log('A/B 会话成本对照（token 为估算，口径见下）')
  for (const [tag, s] of [['A', A], ['B', B]]) {
    console.log(
      `${tag}  ${s.sessionId}  model=${s.model}  turns=${s.turns} steps=${s.steps}  工具调用=${s.toolCallTotal}  拦截=${s.enforcement.denies}`,
    )
    console.log(`   chars=${f(s.chars.total)}（sys ${f(s.chars.system)} / user ${f(s.chars.user)} / asst ${f(s.chars.assistant)} / reas ${f(s.chars.reasoning)} / toolArg ${f(s.chars.toolArgs)} / toolRes ${f(s.chars.toolResult)}）`)
    console.log(`   tokens≈ est4 ${f(s.tokens.est4)} / estCJK ${f(s.tokens.estCJK)}   时长 ${Math.round(s.durationMs / 1000)}s`)
    if (Object.keys(s.enforcement.byTrigger).length) console.log(`   拦截理由: ${JSON.stringify(s.enforcement.byTrigger)}`)
  }
  console.log('差值（B−A）:')
  console.log(`  steps ${report.delta.steps}  工具调用 ${report.delta.toolCalls}  字符 ${f(report.delta.chars)}  tokens≈ ${f(report.delta.tokensEst4)}  拦截 ${report.delta.denies}  时长 ${Math.round(report.delta.durationMs / 1000)}s`)
  console.log('性价比:')
  console.log(`  每步 tokens≈  A ${report.costEffectiveness.a_tokensPerStep} / B ${report.costEffectiveness.b_tokensPerStep}`)
  console.log(`  每次拦截 tokens≈  A ${report.costEffectiveness.a_tokensPerDeny ?? '-'} / B ${report.costEffectiveness.b_tokensPerDeny ?? '-'}`)
  console.log(`⚠ ${report.caveat}`)
}
