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

// ── 拦截闭环（2026-11-28）──────────────────────────────────────────────────
// 这一节只回答「拦截有没有被消费」，**不回答「拦截值不值」**。
//
// 能算的只有成本下界：同一 (会话, 工具, 命令) 被拒 ≥2 次 = 原样重试 = 纯成本
//（成功重试不会产生第二条 deny，所以重复 deny 一定是白拦）。
// 收益（"这次拦对了"）需要人的裁决，而日志里 appeal / grant / approval 一直 0 条——
// 通道都建好了（fg_apply / fg_appeal / approvals 目录），就是没人走。
//
// 别把这一节读成"拦截有效"。它只说明「浪费了几次」，说不出「救了几次」。
const BLOCK_RE = /^(deny|platform-deny|deny-|violation-|reject-|inv-pool-exceeded|ctx-pollution|library-write-deny)/
const CLOSURE_RE = /^(approval-|grants-|grant$|appeal|fg-apply|apply-)/
// 「拦了本来也会失败」：命令语义层面就注定报错，拦与不拦结果相同。
// 这类重复是纯成本，且顺带证明「拦」没有学习效果——同一条命令能被拦 9 次。
const FUTILE_TRIGGER_RE = /platform-deny/

const blocks = ok.filter((r) => BLOCK_RE.test(r.action || ''))
const closures = ok.filter((r) => CLOSURE_RE.test(r.action || ''))

/** 按 key 分组，只留出现 ≥2 次的组。 */
function groupsOf(rows, keyOf) {
  const m = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return [...m.entries()].filter(([, g]) => g.length > 1)
}
const extraOf = (groups) => groups.reduce((a, [, g]) => a + (g.length - 1), 0)

// 口径一：字段指纹（2026-11-28 起的新行才有 tool/command）。
const withPrint = blocks.filter((r) => r.tool && r.command !== undefined)
const byField = groupsOf(withPrint, (r) => `${r.session}|${r.tool}|${r.command}`)

// 口径二：文本指纹，回溯历史。trigger + evidence 前 80 字。
// 不解析命令是刻意的：两行 evidence 逐字相同就意味着同一件事，不会把一件事拆成两组。
// 代价是「同一理由、不同命令」会被并成一组，所以它只作**下界**，不当精确值。
const byText = groupsOf(blocks, (r) => `${r.trigger || ''}|${String(r.evidence || '').slice(0, 80)}`)
const futile = byText.filter(([, g]) => FUTILE_TRIGGER_RE.test(g[0].trigger || g[0].action || ''))

console.log('\n== 拦截闭环 ==')
console.log(
  `  拦截/记档 ${blocks.length} 行，占全部 ${((blocks.length / Math.max(ok.length, 1)) * 100).toFixed(1)}%` +
    `（其余是自查/自报/自记录——日志本身也是元工作）`,
)
console.log(
  `  带 tool+command 指纹 ${withPrint.length}/${blocks.length} 行` +
    (withPrint.length < blocks.length ? '（2026-11-28 之前的行没有指纹，字段口径从本轮起才准）' : ''),
)
if (byField.length) {
  console.log(`  字段口径重复 ${byField.length} 组，多拦 ${extraOf(byField)} 次`)
}
console.log('  ── 回溯口径（trigger + evidence 前 80 字，历史行也算得出）──')
if (!byText.length) {
  console.log('  同文本指纹重复：0 组（无数据时不要读成"零浪费"）')
} else {
  console.log(
    `  同文本指纹重复 ${byText.length} 组，多拦 ${extraOf(byText)} 次 ← **纯成本下界**（成功重试不会留下第二条 deny）`,
  )
  if (futile.length) {
    console.log(
      `    其中「拦了本来也会失败」${futile.length} 组、多拦 ${extraOf(futile)} 次` +
        ' ← 这类应改成「教一次」，拦没有学习效果',
    )
    for (const [, g] of futile.slice(0, 2)) {
      console.log(`      ×${g.length} ${String(g[0].evidence || '').slice(0, 72)}`)
    }
  }
  const useful = extraOf(byText) - extraOf(futile)
  console.log(`    其余 ${useful} 次 ← 可能是必要成本（真防住了），但也说明模型健忘`)
}
console.log(
  `  闭环行（申请/批准/申诉）${closures.length} 条` +
    (closures.length === 0 ? ' ← 通道建好了没人走，收益侧仍然无数据' : ''),
)
