#!/usr/bin/env node
/**
 * 审计日志体检（2026-10-25）：从 AUDIT.log 里找"模块没在工作"的证据。
 * 输出：动作分布 / 重复拒绝 / 异常行 / 时间断层 / 各闸触发量。
 * 只读。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'E:/DSH/focus-guard-main'
const LOG = process.env.FG_AUDIT_FILE || join(ROOT, '.focus-guard', 'AUDIT.log')
if (!existsSync(LOG)) {
  console.log('无审计日志：', LOG)
  process.exit(0)
}
const rows = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return { bad: true, raw: l.slice(0, 80) }
    }
  })

const bad = rows.filter((r) => r.bad)
const ok = rows.filter((r) => !r.bad)
const byAction = {}
const byTrigger = {}
for (const r of ok) {
  byAction[r.action || '?'] = (byAction[r.action || '?'] || 0) + 1
  if (r.trigger) byTrigger[r.trigger] = (byTrigger[r.trigger] || 0) + 1
}
console.log(`总行 ${rows.length}（坏行 ${bad.length}）`)

const top = (o, n = 18) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
console.log('\n== 动作分布（top18）==')
for (const [k, v] of top(byAction)) console.log(`  ${String(v).padStart(6)}  ${k}`)
console.log('\n== 触发分布（top18）==')
for (const [k, v] of top(byTrigger)) console.log(`  ${String(v).padStart(6)}  ${k}`)

// 可疑行：evidence 里带 error/undefined/null/NaN
const suspect = ok.filter((r) => /error|undefined|null|NaN|\[object/.test(String(r.evidence || '')))
console.log(`\n== 可疑行（evidence 含 error/undefined/NaN）${suspect.length} 条，前 6 ==`)
for (const s of suspect.slice(-6)) console.log(`  ${s.action} | ${String(s.evidence).slice(0, 110)}`)

// 时间断层（>30 分钟无记录，可能是会话空闲，仅供参考）
const ts = ok.map((r) => Date.parse(r.ts)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
let maxGap = 0
let gapAt = null
for (let i = 1; i < ts.length; i += 1) {
  const g = ts[i] - ts[i - 1]
  if (g > maxGap) {
    maxGap = g
    gapAt = new Date(ts[i]).toISOString()
  }
}
if (gapAt) console.log(`\n最大时间断层 ${(maxGap / 60000).toFixed(1)} 分钟（恢复于 ${gapAt}）`)

// 近 24h 动作，判断哪些模块最近没在跑
const since = Date.now() - 24 * 3600 * 1000
const recent = ok.filter((r) => Date.parse(r.ts) >= since)
const recentActions = {}
for (const r of recent) recentActions[r.action || '?'] = (recentActions[r.action || '?'] || 0) + 1
console.log(`\n== 近 24h 动作（${recent.length} 行）==`)
for (const [k, v] of top(recentActions, 22)) console.log(`  ${String(v).padStart(6)}  ${k}`)
