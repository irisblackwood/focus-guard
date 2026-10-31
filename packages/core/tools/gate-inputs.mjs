#!/usr/bin/env node
/**
 * 闸门输入量对账（2026-10-31）
 *
 * ## 为什么需要
 *
 * 判据再对，**看的样本少了就等于没看**。
 *
 * 实测（2026-10-31）：`npm run check` 报「文档口径 42 个 md」，直接跑 docs:lint 报 36。
 * 同一根目录、同一个 `listMarkdownFiles`，差 6 个文件；两次的问题条数都是 5 条，闸门一路绿。
 * **没有任何地方会发现"它少看了 6 个文件"**——因为闸门只报自己看了多少个，不报这个数变没变。
 *
 * ## 范式不是新发明的
 *
 * `schema:verify` 早就在做这件事：基线记 254 个工具，这次只有 86，于是报
 * 「疑似插件未加载，不是 schema 漂移」。它做对的地方不是"独立核算 86 对不对"，
 * 而是**跨次比较自报的量**。本工具把同一范式推广到其余三条闸门。
 *
 * 为什么不去独立数一遍文件：口径差异（跳过空文件、扩展名过滤）会让两边永远对不上，
 * 制造噪音。**要防的是"闸门看的样本在无声变化"，这个信息只有闸门自己知道。**
 *
 * ## 判定（按原因分档，不按结果对错分档）
 *
 *   lost   样本变少 —— 缺陷，退 1。文件被删了没更新基线，或者口径被静默缩小
 *   grown  样本变多 —— 正常，只提示。新写了文件，`--update` 更新基线即可
 *
 * **不把"多了"也报红**：会让人开始忽略红。这正是 2026-10-29 那次的教训——
 * 197/200 全红 = 红得没信息量。
 *
 * ## 为什么不进 check 链
 *
 * 新闸门本身也要被检查，进链就是第二条 `schema:verify`（空转 8 天那条）。
 * 先当独立命令跑一段时间，看得见真实用途再谈入链。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BASE = join(REPO, 'packages/core/docs/GATE-INPUTS.json')

/** 三条闸门：各自都支持 `--json`，且都报了 `files`（本次实际看了多少个样本）。 */
const GATES = [
  { key: 'smells', file: 'packages/core/tools/smells.mjs', label: '结构异味' },
  { key: 'lint', file: 'packages/core/tools/lint.mjs', label: '房规' },
  { key: 'docs', file: 'packages/core/tools/docs-lint.mjs', label: '文档口径' },
]

/** 取一次样本数。闸门自己跑挂了就返回 null——那是闸门的问题，这里只如实说取不到。 */
function sample(gate) {
  try {
    const out = execFileSync(process.execPath, [join(REPO, gate.file), '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const n = JSON.parse(out).files
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const now = {}
const lost = []
const grown = []
for (const g of GATES) {
  const n = sample(g)
  if (n === null) {
    console.error(`[gate-inputs] ${g.label}：取不到样本数（闸门自己跑挂了）`)
    continue
  }
  now[g.key] = n
}

if (process.argv.includes('--update')) {
  const doc = {
    _说明: '闸门输入量基线。每条闸门"上次看到多少个样本"。样本变少 = 闸门看的文件少了，绿是假的；变多 = 正常。',
    _维护: '写文件后跑 `npm run gate:inputs -- --update`；发现变少先查清是删了还是口径改了。',
    updated: new Date().toISOString().slice(0, 10),
    inputs: now,
  }
  writeFileSync(BASE, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`[gate-inputs] 基线已更新：${JSON.stringify(now)}`)
  process.exit(0)
}

const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, 'utf8')) : { inputs: {} }
for (const g of GATES) {
  const before = base.inputs?.[g.key]
  const after = now[g.key]
  if (typeof before !== 'number' || typeof after !== 'number') continue
  if (after < before) lost.push(`${g.label}：${before} → ${after}（少 ${before - after}）`)
  else if (after > before) grown.push(`${g.label}：${before} → ${after}（多 ${after - before}）`)
}

const head = GATES.filter((g) => typeof now[g.key] === 'number')
  .map((g) => `${g.label} ${now[g.key]}`)
  .join(' / ')
console.log(`[gate-inputs] ${head}`)

if (lost.length) {
  console.error(`[gate-inputs] ❌ 样本变少 ${lost.length} 项——闸门看的文件少了，绿是假的：`)
  for (const l of lost) console.error(`  ${l}`)
  console.error('  先查清：是真删了（那就 --update），还是扫描口径被改了（那是缺陷）。')
  process.exit(1)
}

if (grown.length) {
  console.log(`[gate-inputs] 样本变多 ${grown.length} 项（正常；确认后 --update 更新基线）`)
  for (const g of grown) console.log(`  ${g}`)
}

console.log('[gate-inputs] PASS：样本量未缩水')
