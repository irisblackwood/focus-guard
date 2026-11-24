#!/usr/bin/env node
/**
 * panel:baseline（2026-11-24）—— 补 ARCH-MAP 缺口 #5「面板基线」
 *
 * 为什么不依赖 dsh-context：FG 的基线必须离线可复算。本工具只读宿主的会话日志，
 * 按**每次请求**取 `usage.{inputTokens,outputTokens,cacheReadTokens}`，
 * 用 `peak-cost.mjs::calcCost` 计价（与成本台账同一函数）。
 *
 * 口径（写进输出，别人能复算）：
 *   inputTokens  = 未命中缓存的输入（宿主字段语义，2026-11-24 对账）
 *   promptTotal  = inputTokens + cacheReadTokens
 *   hitRate      = cacheReadTokens / promptTotal
 *   usd          = calcCost(model, {input:inputTokens,output,cacheRead}, inPeak)
 *
 * 用法：
 *   node packages/core/tools/panel-baseline.mjs                 # 最近 10 个会话
 *   node packages/core/tools/panel-baseline.mjs --last 30
 *   node packages/core/tools/panel-baseline.mjs --session c00d  # 前缀匹配
 *   node packages/core/tools/panel-baseline.mjs --json
 *   node packages/core/tools/panel-baseline.mjs --write          # 写 docs/PANEL-BASELINE.json
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calcCost, isPeakAt } from '../src/peak-cost.mjs'
import { decodeSession, walkSessionFiles } from './lib/sessionDump.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const HOME = process.env.DSH_HOME || join(ROOT, '..')
const SESSIONS = HOME.endsWith('.dsh') ? join(HOME, 'sessions') : join(HOME, '.dsh', 'sessions')

const args = process.argv.slice(2)
const pick = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
const last = Number(pick('--last') || 10)
const only = pick('--session')
const asJson = args.includes('--json')
const shouldWrite = args.includes('--write')
const inPeak = isPeakAt(new Date()).inPeak

function sidOf(file) {
  const parts = file.replace(/\\/g, '/').split('/')
  return parts[parts.length - 2] + '/' + (parts[parts.length - 3] || '')
}

const rows = []
for (const { f, m } of walkSessionFiles(SESSIONS)) {
  if (only && !f.includes(only)) continue
  let lines
  try {
    lines = decodeSession(f)
  } catch {
    continue
  }
  let calls = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let tools = 0
  let model = ''
  for (const j of lines) {
    const header = j.data && (j.data.header || j.data)
    if (header && Array.isArray(header.tools)) {
      tools = header.tools.length
      model = model || header.model || ''
    }
    const u = (j.usage && j.usage.inputTokens !== undefined ? j.usage : null) || (j.data && j.data.usage) || null
    if (!u || u.inputTokens === undefined) continue
    calls += 1
    input += Number(u.inputTokens) || 0
    output += Number(u.outputTokens) || 0
    cacheRead += Number(u.cacheReadTokens) || 0
  }
  if (!calls) continue
  const promptTotal = input + cacheRead
  const usage = { input, output, cacheRead }
  rows.push({
    session: sidOf(f),
    date: new Date(m).toISOString().slice(0, 16),
    calls,
    tools,
    input,
    cacheRead,
    promptTotal,
    output,
    hitRate: Number((cacheRead / Math.max(1, promptTotal)).toFixed(4)),
    usd: calcCost(model || 'deepseek-flash', usage, inPeak),
    formula: 'usd=calcCost(model,{input:uncached,output,cacheRead},inPeak); promptTotal=uncached+cacheRead',
  })
}

const picked = rows.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, only ? 999 : last)
const report = {
  generatedAt: new Date().toISOString(),
  sessionsDir: SESSIONS,
  peak: inPeak,
  rows: picked,
  totals: picked.reduce(
    (a, r) => ({
      calls: a.calls + r.calls,
      promptTotal: a.promptTotal + r.promptTotal,
      cacheRead: a.cacheRead + r.cacheRead,
      uncached: a.uncached + r.input,      output: a.output + r.output,
      usd: Number(((a.usd || 0) + (r.usd || 0)).toFixed(6)),
    }),
    { calls: 0, promptTotal: 0, cacheRead: 0, uncached: 0, output: 0, usd: 0 },
  ),
}

if (shouldWrite) {
  const p = join(ROOT, 'docs', 'PANEL-BASELINE.json')
  writeFileSync(p, JSON.stringify(report, null, 2) + '\n')
  console.log(`[panel:baseline] 写入 ${p}`)
}
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`[panel:baseline] ${picked.length} 个会话 · 峰谷=${inPeak ? '峰' : '谷'}`)
  for (const r of picked) {
    console.log(
      `  ${r.date}  ${r.session.slice(0, 26)}  calls=${String(r.calls).padStart(4)}  ` +
        `tools=${String(r.tools).padStart(3)}  prompt=${r.promptTotal}  cache=${r.cacheRead}  ` +
        `uncached=${r.input}  out=${r.output}  hit=${r.hitRate}  usd=${r.usd}`,
    )
  }
  const t = report.totals
  console.log(`  合计：calls=${t.calls} prompt=${t.promptTotal} cache=${t.cacheRead} uncached=${t.uncached} out=${t.output} usd=${t.usd}`)
}
