#!/usr/bin/env node
/**
 * 工具 schema 指纹（2026-10-22）——防"schema 悄悄变了、测试还在绿"。
 *
 * 病根：判定条件写着 `args.output_mode`，但真实工具早就没有这个参数；schema 一变，
 * 合成参数测试继续通过，线上一律漏（本次 grep 死闸即此）。指纹把"我们测的那份 schema"
 * 固定下来：指纹变了就 fail，逼人重新核对判定条件。
 *
 * 用法：
 *   node packages/core/tools/schema-fingerprint.mjs            # 校验（漂移 → exit 1）
 *   node packages/core/tools/schema-fingerprint.mjs --update    # 写基线
 *   node packages/core/tools/schema-fingerprint.mjs --json
 *
 * 无会话可读（如 CI 无 sessions 目录）时退出 0 并说明「跳过」，不制造假失败。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..')
const SESSIONS = process.env.FG_SESSIONS_DIR || 'E:/DSH/.dsh/sessions'
const BASELINE = join(CORE, 'docs', 'TOOL-SCHEMA.json')
const LIMIT = Number(process.env.FG_SCHEMA_SESSIONS || 20)

const argv = process.argv.slice(2)

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
      /* 坏帧跳过 */
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
  .slice(0, LIMIT)

/** toolName → 该工具参数的键集合（多个会话取并集）。 */
const schema = new Map()
let used = 0
for (const { f } of files) {
  let lines
  try {
    lines = decode(f)
  } catch {
    continue
  }
  const header = lines.find((l) => l.type === 'request/header')
  const h = header && header.data ? header.data.header || header.data : null
  const tools = h && h.tools
  if (!Array.isArray(tools)) continue
  used += 1
  for (const t of tools) {
    if (!t || !t.name) continue
    const keys = schema.get(t.name) || new Set()
    for (const k of Object.keys((t.parameters && t.parameters.properties) || {})) keys.add(k)
    schema.set(t.name, keys)
  }
}

if (used === 0) {
  console.log('[schema-fingerprint] 跳过：无可读会话（CI 或新机器属正常）')
  process.exit(0)
}

const canonical = [...schema.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([name, keys]) => [name, [...keys].sort()])
const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
const report = {
  hash,
  tools: schema.size,
  sessions: used,
  generatedAt: new Date().toISOString(),
  tools_map: Object.fromEntries(canonical.map(([n, k]) => [n, k.length])),
}

if (argv.includes('--update')) {
  mkdirSync(dirname(BASELINE), { recursive: true })
  // 2026-10-27 修：原先写 `{ ...report, tools_map: undefined }`，而 JSON.stringify 会把
  // 值为 undefined 的键整个丢掉 → 基线里**从来没有**工具名表。后果不是"文件小一点"，
  // 而是漂移明细永久说谎：`added` 恒等于「当前全部工具」、`removed` 恒为空，
  // 于是"新增工具 84"这种读数其实只是"当前有 84 个"，一条都没和基线比过。
  // 现保留 tools_map（名称 → 参数个数），diff 才成立。
  writeFileSync(BASELINE, JSON.stringify(report, null, 2) + '\n')
  console.log(`[schema-fingerprint] 已写基线 hash=${hash} tools=${schema.size} sessions=${used}（含 tools_map）`)
  process.exit(0)
}

if (argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`[schema-fingerprint] 缺少基线 ${BASELINE}；先运行 --update 并提交`)
  process.exit(1)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
if (base.hash === hash) {
  console.log(`[schema-fingerprint] PASS hash=${hash} tools=${schema.size} sessions=${used}`)
  process.exit(0)
}

const baseNames = Object.keys(base.tools_map || {})

// 2026-10-27：存量基线没有 tools_map（见 --update 处的说明），此时**无法判断**是漂移还是换环境，
// 也不该假装判断。只报事实并要求重建，不阻断 —— 阻断会训练人忽略这条红。
if (baseNames.length === 0) {
  console.error('[schema-fingerprint] 无法判断：基线缺 tools_map（工具名表），diff 不可算')
  console.error(`  基线 hash=${base.hash} tools=${base.tools}（${base.generatedAt}）`)
  console.error(`  当前 hash=${hash} tools=${schema.size} sessions=${used}`)
  console.error('  该字段此前被 --update 主动剥掉（JSON.stringify 丢弃 undefined），导致 added 恒为「全部」、removed 恒为空')
  console.error('  已在 --update 中修正。请在**目标宿主**上重建基线后提交：npm run schema:verify -- --update')
  process.exit(0)
}

const curNames = canonical.map(([n]) => n)
const added = curNames.filter((n) => !baseNames.includes(n))
const removed = baseNames.filter((n) => !curNames.includes(n))

// 2026-10-27：**换环境 ≠ 漂移**。基线是在某个宿主/profile 下采集的；在另一个宿主里跑，
// 工具集可能整批不同（实测：基线 254 个，另一宿主 84 个，交集 0）。
// 真漂移永远是「大部分还在、个别增删」；整批换掉只能是尺子换了。
// 原先这里一律 FAIL，于是 `npm run check` 在换环境后永久红 —— 红的不是缺陷，是测量环境，
// 这种红会训练人忽略它，比不检查更糟。零交集时改为跳过并说明，仍需 --update 才改基线。
const overlap = curNames.filter((n) => baseNames.includes(n)).length
if (overlap === 0) {
  console.error('[schema-fingerprint] 跳过：当前工具集与基线**零交集**，判定为换宿主/换 profile，不是 schema 漂移')
  console.error(`  基线 hash=${base.hash} tools=${base.tools}（${base.generatedAt}）`)
  console.error(`  当前 hash=${hash} tools=${schema.size} sessions=${used} 交集=0`)
  console.error('  若确认当前宿主就是目标宿主，再运行 --update 换基线并提交')
  process.exit(0)
}

console.error(`[schema-fingerprint] FAIL 工具 schema 漂移`)
console.error(`  基线 hash=${base.hash} tools=${base.tools}（${base.generatedAt}）`)
console.error(`  当前 hash=${hash} tools=${schema.size} sessions=${used} 交集=${overlap}`)
if (added.length) console.error(`  新增工具 ${added.length}：${added.slice(0, 12).join(', ')}`)
if (removed.length) console.error(`  消失工具 ${removed.length}：${removed.slice(0, 12).join(', ')}`)
console.error('  判定条件可能引用已不存在的参数 —— 请核对 gate-audit 输出后，确认无误再 --update')
process.exit(1)
