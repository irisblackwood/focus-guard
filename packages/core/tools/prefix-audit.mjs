#!/usr/bin/env node
/**
 * 前缀构成审计（2026-10-22）
 *
 * 目的：回答"每请求固定前缀花在哪、能砍哪"。缓存命中率已 ~98%，成本 ≈ 请求数 × 前缀，
 * 所以真正的杠杆是**前缀里那些每轮都付的东西**：工具 schema / 技能目录 / 系统提示 / 注入块。
 *
 * 口径：字符数 → est4（chars/4），**不是账单**；真实 token 只在宿主面板。
 *
 * 用法：node packages/core/tools/prefix-audit.mjs [--sid <前缀>] [--json]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = process.env.FG_SESSIONS_DIR || 'E:/DSH/.dsh/sessions'
const argv = process.argv.slice(2)
const SID = argv.includes('--sid') ? argv[argv.indexOf('--sid') + 1] : null
const AS_JSON = argv.includes('--json')

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
    else if (e === 'session.v4.jsonl.zstd') out.push({ f: p, m: st.mtimeMs, size: st.size })
  }
  return out
}

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
      /* 坏帧 */
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

const files = walk(SESSIONS)
  .filter((x) => x.size < 3 * 1024 * 1024)
  .sort((a, b) => b.m - a.m)
// 选会话：默认取"最近且真的带 tools + 有若干步"的那个（子代理/空会话会干扰）。
let pick = null
let lines = null
for (const cand of (SID ? files.filter((x) => x.f.includes(SID)) : files.slice(0, 20))) {
  let ls
  try {
    ls = decode(cand.f)
  } catch {
    continue
  }
  const hd = ls.find((l) => l.type === 'request/header')
  const hh = hd && hd.data ? hd.data.header || hd.data : null
  const nTools = (hh && hh.tools && hh.tools.length) || 0
  const nSteps = ls.filter((l) => l.type === 'step/start').length
  if (nTools > 0 && (SID || nSteps >= 5)) {
    pick = cand
    lines = ls
    break
  }
}
if (!pick) {
  console.log('找不到带工具表的会话', SID || '(最近 20 个)')
  process.exit(0)
}

const header = lines.find((l) => l.type === 'request/header')
const h = header && header.data ? header.data.header || header.data : null
const tools = (h && h.tools) || []

let toolsChars = 0
const perTool = []
for (const t of tools) {
  const n = JSON.stringify(t).length
  toolsChars += n
  perTool.push({ name: t.name, chars: n })
}
perTool.sort((a, b) => b.chars - a.chars)

// 系统/开发者/用户消息里的固定内容
const sysMsgs = lines.filter((l) => l.type === 'system/message')
const devMsgs = lines.filter((l) => l.type === 'developer/message')
const firstUser = lines.find((l) => l.type === 'user/message')
const textOf = (l) => JSON.stringify((l.data && l.data.content) || l.data || '').length

const sysChars = sysMsgs.reduce((a, l) => a + textOf(l), 0)
const devChars = devMsgs.reduce((a, l) => a + textOf(l), 0)
const firstUserText = firstUser ? JSON.stringify(firstUser.data.content || '') : ''

// 技能目录（<available_skills> 块）在首个 user/message 的 system-reminder 里
function blockLen(src, start, end) {
  const i = src.indexOf(start)
  if (i < 0) return 0
  const j = src.indexOf(end, i)
  return j > i ? j - i + end.length : 0
}
const skillsChars = blockLen(firstUserText, '<available_skills>', '</available_skills>')
const fgRulesChars = blockLen(firstUserText, 'focus-guard AI履职执法模型', 'docs/RULES.md')
const fgWsChars = blockLen(firstUserText, '[FG-WORKSPACE]', '决策：') || 0
const costChars = blockLen(firstUserText, '【成本】', '【成本】') || 20

const steps = lines.filter((l) => l.type === 'step/start').length
const totalFixed = toolsChars + sysChars + devChars + skillsChars

const rows = [
  { item: '工具 schema（' + tools.length + ' 个）', chars: toolsChars },
  { item: '系统提示 system/message（' + sysMsgs.length + ' 条）', chars: sysChars },
  { item: '开发者消息 developer/message（' + devMsgs.length + ' 条）', chars: devChars },
  { item: '技能目录 <available_skills>', chars: skillsChars },
  { item: 'FG 执法规则注入', chars: fgRulesChars },
  { item: 'FG 卷宗注入', chars: fgWsChars },
  { item: '成本行', chars: costChars },
]
rows.sort((a, b) => b.chars - a.chars)

const report = {
  session: basename(dirname(pick.f)).replace('session-', '').slice(0, 8),
  steps,
  tools: tools.length,
  totalFixedChars: totalFixed,
  totalFixedTok: Math.round(totalFixed / 4),
  rows: rows.map((r) => ({ ...r, tok: Math.round(r.chars / 4), share: +(r.chars / totalFixed * 100).toFixed(1) })),
  topTools: perTool.slice(0, 10).map((t) => ({ ...t, tok: Math.round(t.chars / 4) })),
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

console.log(`会话 ${report.session} · ${report.steps} 步 · 工具 ${report.tools} 个`)
console.log(`固定前缀合计 ${report.totalFixedChars} 字符 ≈ ${report.totalFixedTok} tok（est4）\n`)
console.log('项目'.padEnd(34) + '字符'.padStart(10) + 'tok'.padStart(9) + '占比'.padStart(8))
for (const r of report.rows) {
  console.log(`${r.item.padEnd(30)}${String(r.chars).padStart(10)}${String(r.tok).padStart(9)}${(r.share + '%').padStart(8)}`)
}
console.log('\n最大的 10 个工具：')
for (const t of report.topTools) console.log(`  ${String(t.tok).padStart(6)} tok  ${t.name}`)
console.log(`\n每步成本下限 ≈ 前缀 ${report.totalFixedTok} tok × 缓存价 $0.003/1M = $${(report.totalFixedTok * 0.003 / 1e6).toFixed(8)}`)
