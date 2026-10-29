#!/usr/bin/env node
/**
 * 前缀抖动探针（2026-10-29）
 *
 * 目的：回答"每步的前缀到底是不是同一段字节"。缓存命中要求**前缀逐字节相同**，
 * 而 FG 自己往系统提示里注入卷宗段（决策 / 约束）——若它每回合变一次，
 * 后面整段会话历史都要按未缓存价重付。
 *
 * 本探针只读会话落盘（`session.v4.jsonl.zstd`），按 step 切段，逐段比哈希：
 *   · 工具表 / system 段 / developer 段 / 首个 user 段，各自一个指纹
 *   · 报"有几个不同版本"与"第一次分歧出现在哪个字段、哪个字符位"
 *
 * 用法：node packages/core/tools/prefix-drift.mjs [--sid <片段>] [--json] [--top 3]
 *       --strict           工具表 / 首条 user 段出现多版本即 exit 1（这两段 FG 完全可控、实测恒定）
 *       --fail-on-system   连 system 段多版本也算红（默认只报不拦：熔断告知、换会话交接都会合法地变一次）
 */

import { basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeSession, firstDiff, textOfMessage, walkSessionFiles } from './lib/sessionDump.mjs'

const SESSIONS = process.env.FG_SESSIONS_DIR || 'E:/DSH/.dsh/sessions'
const argv = process.argv.slice(2)
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SID = arg('--sid')
const AS_JSON = argv.includes('--json')
const TOP = Number(arg('--top', 3)) || 3
const STRICT = argv.includes('--strict')
const FAIL_ON_SYSTEM = argv.includes('--fail-on-system')

const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10)
const textOf = textOfMessage

const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10)
// 只取消息本体：`data` 外层还挂着 `{turn, step}` 元数据，那是**记账编号**不是提示内容，
// 把它算进指纹会把"每步都变"当成前缀抖动（第一次跑就踩了这个坑）。
const textOf = textOfMessage

const files = walkSessionFiles(SESSIONS)
  .filter((x) => x.size < 3 * 1024 * 1024)
  .sort((a, b) => b.m - a.m)

/** 按 step/start 切段；每个 step 记下这一步看到的 tools / system / developer / 首个 user。 */
function stepsOf(lines) {
  const out = []
  let cur = null
  let tools = null
  let sawUser = false
  for (const l of lines) {
    if (l.type === 'request/header') {
      const hd = (l.data && (l.data.header || l.data)) || {}
      if (Array.isArray(hd.tools)) tools = JSON.stringify(hd.tools)
      continue
    }
    if (l.type === 'step/start') {
      cur = { tools, system: [], developer: [], user: null }
      sawUser = false
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (l.type === 'system/message') cur.system.push(textOf(l))
    else if (l.type === 'developer/message') cur.developer.push(textOf(l))
    else if (l.type === 'user/message' && !sawUser) {
      cur.user = textOf(l)
      sawUser = true
    }
  }
  // 头部可能只写一次且出现在首个 step 之后：统一回填，避免把"没读到"当成"变了"。
  for (const s of out) if (!s.tools && tools) s.tools = tools
  return out
}

const report = []
for (const cand of SID ? files.filter((x) => x.f.includes(SID)) : files.slice(0, 20)) {
  let lines
  try {
    lines = decodeSession(cand.f)
  } catch {
    continue
  }
  const steps = stepsOf(lines)
  if (steps.length < 2) continue
  const raw = {
    tools: steps.map((s) => s.tools || ''),
    system: steps.map((s) => s.system.join('\n')),
    developer: steps.map((s) => s.developer.join('\n')),
    user: steps.map((s) => s.user || ''),
  }
  const stat = {}
  for (const [k, arr] of Object.entries(raw)) {
    // 只比"有内容"的步：空值是"这一步没落这段"，不是"这段变了"。
    const idx = arr.map((x, i) => (x ? i : -1)).filter((i) => i >= 0)
    const vals = idx.map((i) => arr[i])
    if (vals.length < 2) {
      stat[k] = { versions: vals.length ? 1 : 0, steps: arr.length, firstChangeAt: -1, chars: vals[0]?.length || 0 }
      continue
    }
    const uniq = [...new Set(vals.map(h))]
    const base = vals[0]
    const changeIdx = vals.findIndex((x) => x !== base)
    stat[k] = {
      versions: uniq.length,
      steps: arr.length,
      firstChangeAt: changeIdx < 0 ? -1 : idx[changeIdx],
      chars: base.length,
    }
  }
  report.push({ session: basename(dirname(cand.f)).replace('session-', '').slice(0, 8), steps: steps.length, fields: stat, raw })
}

if (AS_JSON) {
  console.log(JSON.stringify(report.map(({ raw, ...r }) => r), null, 2))
  process.exit(strictVerdict(report) ? 1 : 0)
}

/**
 * 严格判定：哪些字段"多版本"算红。
 *
 * 分档的理由（别一刀切）：
 *   · `tools` / 首条 `user` 段 FG 完全可控、实测全程恒定 → 多版本必是有人改坏了，红
 *   · `system` 段默认只报不拦：熔断告知（`focus-guard-fuse`）与换会话交接都会合法地变一次，
 *     硬红会变成假阳性——假阳性会训练人加绕过开关，闸门就废了
 *   · 需要更严时显式 `--fail-on-system`，而不是改默认值
 */
function strictVerdict(list) {
  if (!STRICT) return false
  return list.some((r) => {
    const f = r.fields
    const base = (f.tools?.versions || 0) > 1 || (f.user?.versions || 0) > 1
    return base || (FAIL_ON_SYSTEM && (f.system?.versions || 0) > 1)
  })
}

if (!report.length) {
  console.log('找不到 ≥2 步的会话', SID || '(最近 20 个)')
  process.exit(0)
}

for (const r of report.slice(0, TOP)) {
  console.log(`\n会话 ${r.session} · ${r.steps} 步`)
  console.log('字段'.padEnd(12) + '首段字符'.padStart(10) + '不同版本'.padStart(10) + '首次分歧'.padStart(10))
  for (const [k, s] of Object.entries(r.fields)) {
    const at = s.firstChangeAt < 0 ? '-' : `step ${s.firstChangeAt + 1}`
    console.log(`${k.padEnd(10)}${String(s.chars).padStart(12)}${String(s.versions).padStart(12)}${at.padStart(12)}`)
  }
  // 定位首个变了的 system 段里，到底是哪一块在动
  const sys = r.raw.system.filter(Boolean)
  const i = sys.findIndex((x) => x !== sys[0])
  if (i > 0) {
    const at = firstDiff(sys[0], sys[i])
    const lo = Math.max(0, at - 60)
    const hi = Math.min(sys[i].length, at + 90)
    const ctx = sys[i].slice(lo, hi).split('\\n').join('\n      ')
    console.log(`  system 段首次分歧 @${at}：…${ctx}…`)
  }
}

const bad = strictVerdict(report)
if (STRICT) {
  const sysDrift = report.filter((r) => (r.fields.system?.versions || 0) > 1).length
  if (bad) console.log('\n判定：前缀有抖动（exit 1）')
  else if (sysDrift) {
    console.log(
      `\n判定：工具表 / 首条 user 段稳定；${sysDrift} 个会话的 system 段变过（默认不拦——熔断告知与换会话交接会合法地变一次，要看严加 --fail-on-system）`,
    )
  } else console.log('\n判定：前缀稳定（exit 0）')
}
process.exit(bad ? 1 : 0)
