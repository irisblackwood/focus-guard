#!/usr/bin/env node
/**
 * 3.0.8 面板采集处理器（2026-10-22）
 *
 * 用途：把人工从宿主面板抄下来的六项数字，与**会话记录里的结构指标**（steps/denies/时长）合并，
 * 复算命中率与成本，输出每轮表 + 中位数 + 与基线（3.0.7 / 10-18 A/B）的对照。
 *
 * 口径纪律：
 *   - 面板数字是唯一实证 token 来源；本脚本不估算 token，只做校验与汇总。
 *   - 命中率 = 缓存读取 /(缓存读取 + 未缓存输入)，不含输出。若面板值与本式不符，告警。
 *   - 成本按官方价目复算；峰谷按时段判定（北京 09-12 / 14-18 工作日为峰，×2）。
 *   - 只认**同一 profile、同一 8 任务**的轮次；n<5 时输出「样本不足，仅方向参考」。
 *
 * 输入：JSON 数组（见 --init 生成模板）
 *   [{ "run":1, "sid":"002c143b", "at":"2026-10-22T21:20:00+08:00",
 *      "total":231544, "uncached":50561, "cacheRead":175360, "output":5623,
 *      "panelCost":0.011484, "elapsedSec":null }]
 *
 * 用法：
 *   node packages/core/tools/collect-panel.mjs --init            # 生成模板文件
 *   node packages/core/tools/collect-panel.mjs panel.json        # 汇总
 *   node packages/core/tools/collect-panel.mjs panel.json --json
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const SESSIONS = process.env.FG_SESSIONS_DIR || 'E:/DSH/.dsh/sessions'
const TEMPLATE = join(process.cwd(), 'panel-runs.json')

// 官方价目（USD / 1M tokens）：缓存命中 / 未缓存 / 输出；高峰 = 空闲 ×2
const PRICE_OFFPEAK = { cacheRead: 0.003, uncached: 0.15, output: 0.6 }
const PRICE_PEAK = { cacheRead: 0.006, uncached: 0.3, output: 1.2 }

function isPeak(at) {
  const d = at ? new Date(at) : new Date()
  // 转北京时间
  const bj = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000)
  const dow = bj.getDay()
  const minutes = bj.getHours() * 60 + bj.getMinutes()
  if (dow === 0 || dow === 6) return false
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

// 面板成本单位（2026-10-22 人类确认）：宿主用量面板显示的是**人民币 ¥**。
// 官方价目是 USD/1M，故按汇率换算后与面板核对；汇率可被 FG_USD_CNY 覆盖（默认 7.1）。
const USD_CNY = Number(process.env.FG_USD_CNY || 7.1)

function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (e === 'session.v4.jsonl.zstd') out.push(p)
  }
  return out
}

const FILES = walk(SESSIONS)

function decode(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      /* 跳坏帧 */
    }
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

/** 从会话记录取结构指标：steps / denies / 工具调用 / 时长。 */
function structureOf(sidPrefix) {
  if (!sidPrefix) return null
  const file = FILES.find((f) => f.includes(String(sidPrefix).replace(/^session-/, '')))
  if (!file) return { found: false }
  const lines = decode(file)
  const stepStarts = lines.filter((l) => l.type === 'step/start').length
  const turns = lines.filter((l) => l.type === 'turn/start').length
  const calls = lines.filter((l) => l.type === 'tool/call')
  // 拦截计数：按 FG 的真实拒绝文案判定（2026-10-22 修：只用 deny/拦截 会漏掉
  // 「本机环境：用 bat 替代 cat」「该工具需先调 fg_apply」「命中绝对红线」等不同措辞）。
  const DENY_RE = /focus-guard-native|拦截|红线|fg_apply|绝对|本机环境|禁|取证记录/
  const denies = lines.filter((l) => l.type === 'tool/result' && DENY_RE.test(JSON.stringify(l.data)))
  const first = lines.find((l) => l.type === 'turn/start')
  const last = lines.filter((l) => l.type === 'turn/end').pop() || lines[lines.length - 1]
  const t0 = first && first.data && first.data.at ? Date.parse(first.data.at) : null
  const t1 = last && last.data && last.data.at ? Date.parse(last.data.at) : null
  return {
    found: true,
    file,
    turns,
    steps: stepStarts,
    toolCalls: calls.length,
    denies: denies.length,
    elapsedSec: t0 && t1 ? Math.round((t1 - t0) / 1000) : null,
  }
}

function summarize(runs) {
  const rows = runs.map((r) => {
    const peak = isPeak(r.at)
    const price = peak ? PRICE_PEAK : PRICE_OFFPEAK
    const total = Number(r.total) || 0
    const uncached = Number(r.uncached) || 0
    const cacheRead = Number(r.cacheRead) || 0
    const output = Number(r.output) || 0
    const sum = uncached + cacheRead + output
    const cost =
      (cacheRead * price.cacheRead + uncached * price.uncached + output * price.output) / 1e6
    const hit = cacheRead + uncached > 0 ? (cacheRead / (cacheRead + uncached)) * 100 : null
    const st = structureOf(r.sid)
    return {
      run: r.run ?? null,
      sid: r.sid || null,
      at: r.at || null,
      peak,
      total,
      uncached,
      cacheRead,
      output,
      sum,
      sumMatches: total ? sum === total : null,
      hitRate: hit,
      cost,
      costCNY: Number((cost * USD_CNY).toFixed(6)),
      panelCost: r.panelCost == null ? null : Number(r.panelCost),
      // 面板成本是 ¥，故与 costCNY 比；差额 >0.002 视为口径不一致
      costDelta: r.panelCost == null ? null : Number((cost * USD_CNY - Number(r.panelCost)).toFixed(6)),
      steps: st && st.found ? st.steps : null,
      denies: st && st.found ? st.denies : null,
      elapsedSec: r.elapsedSec ?? (st && st.found ? st.elapsedSec : null),
      structureFound: Boolean(st && st.found),
    }
  })

  const med = (k) => {
    const v = rows.map((x) => x[k]).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
    if (!v.length) return null
    const m = Math.floor(v.length / 2)
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
  }

  return {
    runs: rows,
    median: {
      total: med('total'),
      uncached: med('uncached'),
      cacheRead: med('cacheRead'),
      hitRate: med('hitRate'),
      cost: med('cost'),
      steps: med('steps'),
      denies: med('denies'),
      elapsedSec: med('elapsedSec'),
    },
    n: rows.length,
    note: rows.length < 5 ? '样本不足 5 轮：仅方向参考，不得作为结论（BENCH.md A/B 协议）' : '达到 ≥5 轮，可作为 3.0.8 基线',
  }
}

function fmt(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '—'
  return digits ? Number(v).toFixed(digits) : String(Math.round(v))
}

const args = process.argv.slice(2)
if (args.includes('--init')) {
  if (existsSync(TEMPLATE)) {
    console.log(`已存在：${TEMPLATE}（不覆盖）`)
    process.exit(0)
  }
  const tpl = [1, 2, 3, 4, 5].map((i) => ({
    run: i,
    sid: '',
    at: '',
    total: 0,
    uncached: 0,
    cacheRead: 0,
    output: 0,
    panelCost: null,
    elapsedSec: null,
  }))
  writeFileSync(TEMPLATE, JSON.stringify(tpl, null, 2))
  console.log(`已生成模板：${TEMPLATE}\n填写每轮的 sid（会话 id 前 8 位即可）与面板六项后运行本脚本。`)
  process.exit(0)
}

const input = args.find((a) => !a.startsWith('--'))
if (!input || !existsSync(input)) {
  console.error('用法：node packages/core/tools/collect-panel.mjs <panel.json> [--json]（--init 生成模板）')
  process.exit(2)
}

const runs = JSON.parse(readFileSync(input, 'utf8'))
const result = summarize(Array.isArray(runs) ? runs : [runs])

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

console.log('轮次 | sid       | 峰/谷 | 总 token  | 未缓存   | 缓存读取  | 输出   | 命中率  | 成本$   | 成本¥   | 面板¥   | 差额   | steps | denies | 耗时 s')
for (const r of result.runs) {
  const flag = r.sumMatches === false ? ' ⚠求和不等' : ''
  const drift = r.costDelta != null && Math.abs(r.costDelta) > 0.002 ? ' ⚠成本不符' : ''
  console.log(
    `${fmt(r.run)}    | ${String(r.sid || '-').slice(0, 8)}   | ${r.peak ? '峰' : '谷'}    | ${fmt(r.total).padStart(9)} | ${fmt(r.uncached).padStart(8)} | ${fmt(r.cacheRead).padStart(9)} | ${fmt(r.output).padStart(6)} | ${fmt(r.hitRate, 2).padStart(6)}% | ${fmt(r.cost, 6).padStart(7)} | ${fmt(r.costCNY, 4).padStart(7)} | ${fmt(r.panelCost, 4).padStart(7)} | ${fmt(r.costDelta, 4).padStart(6)} | ${fmt(r.steps).padStart(5)} | ${fmt(r.denies).padStart(6)} | ${fmt(r.elapsedSec).padStart(6)}${flag}${drift}`,
  )
}
const m = result.median
console.log(
  `\n中位数：总 ${fmt(m.total)} / 未缓存 ${fmt(m.uncached)} / 缓存读取 ${fmt(m.cacheRead)} / 命中率 ${fmt(m.hitRate, 2)}% / 成本 $${fmt(m.cost, 6)} / steps ${fmt(m.steps)} / denies ${fmt(m.denies)}`,
)
console.log(`n=${result.n} · ${result.note}`)
process.exit(0)
