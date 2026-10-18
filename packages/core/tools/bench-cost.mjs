#!/usr/bin/env node
/**
 * FocusGuard · 成本/效果基准（读已有落盘数据，不跑模型）
 *
 * 它做的不是"再花一次钱跑一遍"，而是把已经落盘的三份记录汇总成可比较的指标：
 *   ① `.ai/CASE_FILE.md` 【五】成本台账  → token 与 USD（谁在花钱）
 *   ② `.focus-guard/AUDIT.log`          → 拦截次数 / 理由分布（拦了什么）
 *   ③ 同一文件里的 appeal-granted       → 误伤后获准的条数（拦错了多少）
 *
 * 用法：
 *   node tools/bench-cost.mjs                 # 人读汇总
 *   node tools/bench-cost.mjs --json          # 机器可读
 *   node tools/bench-cost.mjs --since 2026-10-18
 *
 * A/B 对照（回答"FG 值不值"）：
 *   同一批任务、同一模型，FG 开 5 次 / 关 5 次，各自跑完执行本脚本并对比输出。
 *   关 FG 的那几轮不会写 AUDIT.log，所以只能比 token 与轮次——这是设计使然，不是漏采。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..', '..')
const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const sinceIdx = args.indexOf('--since')
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null

const CASE_FILE = process.env.FG_CASE_FILE || join(REPO, '.ai', 'CASE_FILE.md')
const AUDIT_FILE = process.env.FG_AUDIT_FILE || join(REPO, '.focus-guard', 'AUDIT.log')

/** 解析【五】成本台账行：| 时间 | 模型 | 时段 | 输入未缓存 | 缓存读 | 输出 | 成本USD | */
export function parseCostRows(text) {
  const start = text.indexOf('【五】成本台账')
  if (start < 0) return []
  const rows = []
  for (const raw of text.slice(start).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) {
      if (rows.length > 0) break
      continue
    }
    const cells = line.split('|').map((c) => c.trim())
    const [ts, model, peak, input, cacheRead, output, usd] = cells.slice(1)
    if (!ts || !/^\d{4}-\d{2}-\d{2}/.test(ts)) continue
    rows.push({
      ts,
      model,
      peak: peak === '峰',
      input: Number(input) || 0,
      cacheRead: Number(cacheRead) || 0,
      output: Number(output) || 0,
      usd: Number(usd) || 0,
    })
  }
  return rows
}

/** 解析 AUDIT.log：按 action/trigger 统计，并可算"拦截→获准"的误伤比。 */
export function parseAudit(text) {
  const rows = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* 损坏行跳过：审计文件可能正被并发追加 */
    }
  }
  return rows
}

function readText(file) {
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const costRows = parseCostRows(readText(CASE_FILE)).filter((r) => !since || r.ts >= since)
const auditRows = parseAudit(readText(AUDIT_FILE)).filter((r) => !since || String(r.ts || '') >= since)

const tokenSum = costRows.reduce((a, r) => a + r.input + r.cacheRead + r.output, 0)
const usdSum = costRows.reduce((a, r) => a + r.usd, 0)
const byTrigger = new Map()
const byAction = new Map()
for (const r of auditRows) {
  byAction.set(r.action, (byAction.get(r.action) || 0) + 1)
  if (r.action === 'deny') byTrigger.set(r.trigger || 'unspecified', (byTrigger.get(r.trigger || 'unspecified') || 0) + 1)
}
const denies = byAction.get('deny') || 0
const appealsGranted = byAction.get('appeal-granted') || 0

const report = {
  ts: new Date().toISOString(),
  since,
  cost: {
    rows: costRows.length,
    tokens: tokenSum,
    usd: Number(usdSum.toFixed(4)),
    byModel: [...costRows.reduce((m, r) => m.set(r.model, (m.get(r.model) || 0) + r.input + r.cacheRead + r.output), new Map())]
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
  },
  enforcement: {
    denies,
    appealsGranted,
    falsePositiveRatio: denies === 0 ? 0 : Number((appealsGranted / denies).toFixed(4)),
    topTriggers: [...byTrigger.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([trigger, n]) => ({ trigger, n })),
  },
  files: { CASE_FILE, AUDIT_FILE },
}

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`成本基准（${since ? `自 ${since}` : '全量'}）`)
  console.log(`  台账行数    ${report.cost.rows}`)
  console.log(`  token 合计  ${report.cost.tokens}`)
  console.log(`  USD 合计    ${report.cost.usd}`)
  if (report.cost.byModel.length > 0) {
    console.log('  按模型：')
    for (const m of report.cost.byModel) console.log(`    ${m.model}: ${m.tokens}`)
  }
  console.log(`拦截总数    ${report.enforcement.denies}`)
  console.log(`  误伤获准  ${report.enforcement.appealsGranted}（比例 ${(report.enforcement.falsePositiveRatio * 100).toFixed(2)}%）`)
  if (report.enforcement.topTriggers.length > 0) {
    console.log('  拦截理由 Top：')
    for (const t of report.enforcement.topTriggers) console.log(`    ${t.trigger}: ${t.n}`)
  }
  if (report.cost.rows === 0) {
    console.log('  ⚠ 台账为空：宿主可能未提供 usage（FG 会连续 5 次缺失后告警），或本机从未跑过带成本的调用')
  }
}
