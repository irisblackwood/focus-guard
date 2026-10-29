#!/usr/bin/env node
/**
 * 审计日志体检（2026-10-25）：从 AUDIT.log 里找"模块没在工作"的证据。
 * 输出：动作分布 / 重复拒绝 / 异常行 / 时间断层 / 各闸触发量 / **行契约体检**。
 * 只读。
 *
 * 2026-10-29 增补「行契约体检」：2026-10-29 的重构就是靠这几项发现问题的——
 * 当时没有任何工具能看见"同一份日志里有三种行形态"，全靠临时探针脚本。
 * 现在把探针固化进本工具，下次漂移能自己报出来。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_REQUIRED_FIELDS } from '../src/core/audit-writer.mjs'

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

// ── 行契约体检（2026-10-29）────────────────────────────────────────────────
// 三项都能在历史上真的红过：缺字段（fuse-waste 11 行）、seq 撞号（17 组）、
// 写入器形态分裂（带 chain/ref 的 vs 不带的 vs 缺字段的）。
console.log('\n== 行契约体检 ==')

const missing = new Map()
for (const r of ok) {
  const lack = AUDIT_REQUIRED_FIELDS.filter((k) => !(k in r))
  if (lack.length) missing.set(lack.join('+'), (missing.get(lack.join('+')) || 0) + 1)
}
if (missing.size === 0) console.log('  七字段：全部齐备 ✅')
else {
  console.log(`  七字段：${[...missing.values()].reduce((a, b) => a + b, 0)} 行缺字段 ❌`)
  for (const [k, v] of [...missing].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)} 行缺 ${k}`)
}

const seqRows = ok.filter((r) => r.seq)
const seqDup = seqRows.length - new Set(seqRows.map((r) => r.seq)).size
console.log(
  `  事件号：${seqRows.length} 行带 seq，唯一 ${new Set(seqRows.map((r) => r.seq)).size}` +
    (seqDup ? ` ❌ 重复 ${seqDup} 组（因果链按 seq 建索引，撞号即丢边）` : ' ✅'),
)

// 形态分组：按"是否带 seq / 七字段是否齐"给每行归类。
// chain 不计入形态——因果链本来就只挂在任务链上的事件，缺它是正常，不是漂移。
const shapeOf = (r) =>
  `${r.seq ? 'seq' : '无seq'}/${AUDIT_REQUIRED_FIELDS.every((k) => k in r) ? '7/7' : '残行'}`
const shapes = {}
for (const r of ok) shapes[shapeOf(r)] = (shapes[shapeOf(r)] || 0) + 1
console.log(`  行形态：${Object.keys(shapes).length} 种`)
for (const [k, v] of Object.entries(shapes).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)}  ${k}`)
console.log(`  因果链：${ok.filter((r) => r.chain).length} 行带 chain（可选字段，缺属正常）`)
if (Object.keys(shapes).length > 1) {
  console.log('  ↑ 超过 1 种说明写入点还没收敛到同一个构造点（buildAuditRow）')
}
