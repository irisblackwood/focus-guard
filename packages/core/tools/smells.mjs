#!/usr/bin/env node
/**
 * 结构异味扫描（tools/smells.mjs，2026-10-27）——内置化第二件，零依赖。
 *
 * 为什么自己写：
 *   上一轮用 `dsh-refactor-insight` 扫出 57 条"硬事实"，逐条核实后**大半是噪音**：
 *   `long-function` 32 条里大半是测试文件（测试函数长 ≠ 认知负荷高）；
 *   `todo-density` 8 条全是**诚实的空头申报**（`profileLoader.mjs:50-51` 已登记为
 *   'no engine implementation, TODO'，`profile.test.mjs:107-112` 把这条申报本身锁成断言）。
 *   工具只匹配 `TODO` 三个字母，分不出"已申报"与"已遗忘"。
 *
 * 本工具的取舍：
 *   ① **源文件与测试文件分开报**。测试函数长是常态，混在一起报等于把真问题淹掉。
 *   ② **不报 todo-density**。它区分不了"已申报的空头条款"与"遗忘的债"，报了只会制造噪音；
 *      要查空头条款用 `npm run quality:audit`（那才是结构判定）。
 *   ③ 指标只有三条，都是可复算的：文件行数 / 函数行数 / 嵌套深度。
 *
 * 已知局限（如实申报，别以为它覆盖了）：
 *   **匿名回调不计函数长度**。`FUNC_START` 三条正则都要求行首具名
 *   （`function name(` / `const name = (...) => {` / `const name = x => {`），
 *   所以 `test('t', () => { …200 行… })` 与 `setInterval(() => { … })` 这类量不到。
 *   **漏报比误报隐蔽**——不报不等于没问题。要扩这个口子，先看
 *   `tests/toolchain-tools.test.mjs` 里那条"已知局限"用例，它会一起红。
 *
 * 用法：
 *   node packages/core/tools/smells.mjs            # 明细（源文件优先）
 *   node packages/core/tools/smells.mjs --brief    # 一行（供 npm run check）
 *   node packages/core/tools/smells.mjs --json
 *   node packages/core/tools/smells.mjs --strict   # 超债务上限 exit 1
 *
 * 退出码：默认恒 0；`--strict` 时**源文件异味数 > BUDGET** 才 exit 1（测试文件永不计入）。
 *
 * 为什么是"债务上限"而不是"有异味就红"（2026-10-27 改）：
 *   首版 `--strict` = 有任何源文件异味就 exit 1。当前 28 条，其中 `pipeline.mjs` 1243 行、
 *   `preExecuteListener` 398 行——**短期内清不到零**（拆它有风险不对称问题，见 ARCH-MAP 缺口 #7）。
 *   那条闸门永远红，等于没有闸门。所以改成上限 28 的棘轮：不许新增，降下来后手工下调。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 去字面量与注释的共用实现（2026-10-27 抽到 tools/lib/）。
// 本文件第一版自己写了一份、**忘了处理正则字面量**，于是 `/['"]/` 里的引号被当成字符串开头，
// 一路吞到下一个引号，把中间的 `export function preExecuteListener` 抹平——398 行的函数
// 量成了"不存在"。同一段逻辑写两遍就一定会分叉，现统一。
import { stripLiterals as stripNoise } from './lib/source-text.mjs'
import { loadRatchet } from './lib/ratchet.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 仓库根可覆盖：测试要造夹具目录跑真扫描，否则这个工具自己没被测量。
const REPO = process.env.FG_REPO_ROOT ? resolve(process.env.FG_REPO_ROOT) : resolve(HERE, '../../..')

const argv = process.argv.slice(2)
const BRIEF = argv.includes('--brief')
const AS_JSON = argv.includes('--json')
const STRICT = argv.includes('--strict')

const THRESHOLDS = {
  fileLines: 400,
  funcLines: 80,
  nesting: 5,
  // 重复块：连续 8 行（去空行、去注释与字面量后）内容相同即算一块；
  // 窗口内字符总数 ≥120 才计入，避免 `}`/`});` 这类结构性行凑数。
  dupWindow: 8,
  dupMinContent: 120,
}

/**
 * 债务上限（棘轮）：源文件异味不许超过这个数。降存量后手工下调，不许反弹。
 * 现状 8 条（2026-10-27 从 28 降下来：seams/preGuard/stopGuard/postProgress/guard/* 均已拆）。
 */
const BUDGET = 8

/**
 * 重复块上限（独立棘轮，2026-10-29）。
 *
 * 为什么单开一条：`file-length` / `long-function` / `deep-nesting` 量的是"单点复杂度"，
 * 重复块量的是"同一段逻辑有几份"。混进同一个 BUDGET 会让两类债互相掩护——
 * 拆函数能降前三条，却完全不动重复。
 *
 * 起因：审计行构造曾散在 5 处，字段集各不相同，真实 AUDIT.log 里漂出三种行形态。
 * 那 5 份复制体穿过了 lint / smells / quality / schema 四道门禁一次没被看见——
 * **漏报比误报隐蔽**，看不见不等于不存在。
 *
 * 首测基线 41 处（2026-10-29）。存量里最大的一坨是 `walk()`：同一个 49 行目录遍历函数
 * 在 6 个 tools 文件里各有一份（`prefix-audit` / `schema-fingerprint` / `capture-fixtures` /
 * `gate-audit` / `collect-panel` / `module-audit`）。清掉它能一次性降到 20 上下，但那是
 * 另一件事——这里先立棘轮，不许再往上。
 */
const DUP_BUDGET = 41


const SKIP_DIRS = new Set(['node_modules', '.git', '.stryker-tmp', '.mutate-tmp', 'reports', '.ai'])
const ROOTS = ['packages/core/src', 'packages/core/tools', 'packages/core/tests', 'packages/core/hooks', 'packages/extended/src'].map(
  (d) => resolve(REPO, d),
)

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(mjs|cjs|js)$/.test(e)) out.push(p)
  }
  return out
}

const FUNC_START = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>\s*\{/,
]

/**
 * 用括号配平量函数体长度与最大嵌套深度。
 * 不追求完整 AST——只量"这个函数有多长、最深几层"，括号配平足够且不会误报。
 */
function measureFunctions(lines) {
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    let name = null
    for (const re of FUNC_START) {
      const m = lines[i].match(re)
      if (m) {
        name = m[1]
        break
      }
    }
    if (!name) continue
    // 找到该函数的**函数体**开括号。必须跳过参数表：`function f({ warn, observe } = {}) {`
    // 的参数里有花括号，直接数 `{`/`}` 会在同一行归零，把 400 行的函数量成 1 行
    // （2026-10-27 首版就是这么漏掉 `preExecuteListener` 的）。故只在圆括号深度 0 时计花括号。
    let depth = 0
    let paren = 0
    let started = false
    let maxDepth = 0
    let end = i
    for (let k = i; k < lines.length; k += 1) {
      const line = lines[k]
      for (const ch of line) {
        if (ch === '(') {
          paren += 1
          continue
        }
        if (ch === ')') {
          paren -= 1
          continue
        }
        if (paren > 0) continue // 参数表里的花括号不算函数体
        if (ch === '{') {
          depth += 1
          started = true
          if (depth > maxDepth) maxDepth = depth
        } else if (ch === '}') {
          depth -= 1
        }
      }
      if (started && depth === 0) {
        end = k
        break
      }
    }
    if (!started) continue
    found.push({ name, start: i + 1, lines: end - i + 1, depth: maxDepth })
    i = end // 跳过函数体，避免把内层函数重复计数
  }
  return found
}

/**
 * 把源码切成"有内容的行"：去首尾空白、折叠内部空白、丢掉空行。
 * 行号保留原文件行号，报告时能直接跳过去。
 */
function contentLines(plain) {
  const out = []
  const raw = plain.split('\n')
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i].trim().replace(/\s+/g, ' ')
    if (!t) continue
    out.push({ line: i + 1, t })
  }
  return out
}

/**
 * 重复块检测（2026-10-29）：滑动窗口 + 前后扩展。
 *
 * 做法：对每个"连续 dupWindow 行"的窗口取归一化文本当键，落进桶；桶里 ≥2 处即候选。
 * 候选再从窗口起点**向前扩到块首、向后量到块尾**，得到极大重复块——
 * 同一个重复块会由它内部的每个窗口各报一次，但扩展后起点相同，用 key 天然去重。
 *
 * 取舍：
 *   - 只比文本、不比语义。改写过的复制（换个变量名）测不出来，这是已知局限。
 *   - 同文件内的重复要求两段不重叠，否则 `}` 序列会自己跟自己"重复"。
 *   - 混合重复（src ↔ test）归入测试口径，不占源文件预算——
 *     它多半是"测试抄了实现"，不是"实现里有两份逻辑"。
 */
function findDuplicateBlocks(entries) {
  const buckets = new Map()
  for (const e of entries) {
    const cl = e.cl
    for (let k = 0; k + THRESHOLDS.dupWindow <= cl.length; k += 1) {
      let content = 0
      for (let d = 0; d < THRESHOLDS.dupWindow; d += 1) content += cl[k + d].t.length
      if (content < THRESHOLDS.dupMinContent) continue
      let key = ''
      for (let d = 0; d < THRESHOLDS.dupWindow; d += 1) key += cl[k + d].t + '\n'
      let arr = buckets.get(key)
      if (!arr) buckets.set(key, (arr = []))
      arr.push({ file: e.rel, isTest: e.isTest, cl, idx: k })
    }
  }

  const seen = new Set()
  const found = []
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue
    for (let a = 0; a < arr.length - 1; a += 1) {
      for (let b = a + 1; b < arr.length; b += 1) {
        const p = arr[a]
        const q = arr[b]
        let s1 = p.idx
        let s2 = q.idx
        // 向前扩到块首
        while (s1 > 0 && s2 > 0 && p.cl[s1 - 1].t === q.cl[s2 - 1].t) {
          s1 -= 1
          s2 -= 1
        }
        // 同文件两段不许重叠（否则自己套自己）
        if (p.file === q.file && Math.abs(s1 - s2) < THRESHOLDS.dupWindow) continue
        // 向后量块尾
        let len = 0
        while (s1 + len < p.cl.length && s2 + len < q.cl.length && p.cl[s1 + len].t === q.cl[s2 + len].t) len += 1
        if (len < THRESHOLDS.dupWindow) continue
        const lineA = p.cl[s1].line
        const lineB = q.cl[s2].line
        const key = `${p.file}:${lineA}|${q.file}:${lineB}|${len}`
        if (seen.has(key)) continue
        seen.add(key)
        // 一条重复块会被它内部的每个窗口各找到一次；扩展后起点相同，key 去重即可收敛。
        // 两侧各报一条：谁抄谁分不清，两边都是债。
        found.push({ scope: !p.isTest && !q.isTest ? 'src' : 'test', file: p.file, line: lineA, len, other: `${q.file}:${lineB}` })
        found.push({ scope: !p.isTest && !q.isTest ? 'src' : 'test', file: q.file, line: lineB, len, other: `${p.file}:${lineA}` })
      }
    }
  }

  // 同一位置可能对多个伙伴成立（三份以上共享同一段），只留最长的那条——
  // 否则一个块被拆成 3 条报，数量看着吓人，读的人反而找不到重点。
  const best = new Map()
  for (const f of found) {
    const k = `${f.file}:${f.line}`
    const prev = best.get(k)
    if (!prev || f.len > prev.len) best.set(k, f)
  }
  return [...best.values()].map((f) => ({
    kind: 'duplicate-block',
    scope: f.scope,
    file: f.file,
    line: f.line,
    value: f.len,
    detail: `与 ${f.other} 重复 ${f.len} 行`,
  }))
}

const findings = []
const files = ROOTS.flatMap((r) => walk(r))
const entries = []

for (const file of files) {
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const rel = relative(REPO, file).replace(/\\/g, '/')
  const isTest = /\/tests\/|\.test\.mjs$/.test(rel)
  const plain = stripNoise(src)
  const lines = plain.split('\n')
  const total = src.split('\n').length
  entries.push({ rel, isTest, cl: contentLines(plain) })

  if (total > THRESHOLDS.fileLines) {
    findings.push({ kind: 'file-length', scope: isTest ? 'test' : 'src', file: rel, line: 1, value: total, detail: `${total} 行（阈值 ${THRESHOLDS.fileLines}）` })
  }

  for (const fn of measureFunctions(lines)) {
    if (fn.lines > THRESHOLDS.funcLines) {
      findings.push({
        kind: 'long-function',
        scope: isTest ? 'test' : 'src',
        file: rel,
        line: fn.start,
        value: fn.lines,
        detail: `${fn.name}() ${fn.lines} 行（阈值 ${THRESHOLDS.funcLines}）`,
      })
    }
    if (fn.depth > THRESHOLDS.nesting) {
      findings.push({
        kind: 'deep-nesting',
        scope: isTest ? 'test' : 'src',
        file: rel,
        line: fn.start,
        value: fn.depth,
        detail: `${fn.name}() 嵌套 ${fn.depth} 层（阈值 ${THRESHOLDS.nesting}）`,
      })
    }
  }
}

const srcFindings = findings.filter((f) => f.scope === 'src')
const testFindings = findings.filter((f) => f.scope === 'test')
const dupAll = findDuplicateBlocks(entries)
const dupSrc = dupAll.filter((f) => f.scope === 'src')
const dupTest = dupAll.filter((f) => f.scope === 'test')
const byKind = {}
for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1

const overBudget = srcFindings.length > BUDGET
const dupOverBudget = dupSrc.length > DUP_BUDGET

// 台账（3.3 B）：闸门只防涨，这张表催还。读取与容错都在 ratchet.mjs 里——
// 塞在这里会把 smells.mjs 自己顶过 400 行，变成一条新的结构异味（2026-10-30 实测踩过）。
const ledgerCheck = loadRatchet(REPO, { smells: srcFindings.length, duplicates: dupSrc.length })
const ledgerBad = ledgerCheck.findings.length > 0

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        files: files.length,
        thresholds: THRESHOLDS,
        byKind,
        srcFindings,
        testFindings,
        budget: BUDGET,
        duplicates: { budget: DUP_BUDGET, src: dupSrc, test: dupTest },
        ratchet: { version: ledgerCheck.version || null, entry: ledgerCheck.entry, findings: ledgerCheck.findings, skipped: ledgerCheck.skipped || null },
      },
      null,
      2,
    ),
  )
} else if (BRIEF) {
  const parts = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
  const gate = overBudget ? `❌ 超上限 ${BUDGET}` : `✅ 上限 ${BUDGET}`
  const dupGate = dupOverBudget ? `❌ 超上限 ${DUP_BUDGET}` : `✅ 上限 ${DUP_BUDGET}`
  const ratchetGate = ledgerBad ? `❌ 台账 ${ledgerCheck.findings.length} 条` : '✅ 台账'
  console.log(
    `结构异味：${files.length} 文件，源文件 ${srcFindings.length} 条（${gate}）/ 测试 ${testFindings.length} 条` +
      `；重复块 源 ${dupSrc.length} 条（${dupGate}）/ 测试 ${dupTest.length} 条${parts.length ? `（${parts.join(' / ')}）` : ''}；${ratchetGate}`,
  )
  for (const f of ledgerCheck.findings) console.log(`  ✗ [${f.rule}] ${f.detail}`)
} else {
  const show = (title, list) => {
    console.log(`\n${title}（${list.length} 条）`)
    if (!list.length) {
      console.log('  无。')
      return
    }
    for (const f of list.sort((a, b) => b.value - a.value)) console.log(`  ${f.file}:${f.line}\t[${f.kind}] ${f.detail}`)
  }
  console.log(`结构异味：${files.length} 文件；阈值 文件 ${THRESHOLDS.fileLines} 行 / 函数 ${THRESHOLDS.funcLines} 行 / 嵌套 ${THRESHOLDS.nesting} 层`)
  show('源文件', srcFindings)
  show('测试文件（不计入阻断：测试函数长是常态，不是债务）', testFindings)
  show(`重复块 · 源文件（窗口 ${THRESHOLDS.dupWindow} 行）`, dupSrc)
  show(`重复块 · 测试（混合重复也归这里）`, dupTest)
  console.log('\n不报 todo-density：它分不出「已申报的空头条款」与「遗忘的债」。查空头条款用 npm run quality:audit。')
  console.log('重复块只比文本、不比语义：改过名的复制测不出来（已知局限，别当它覆盖了）。')
  console.log(
    `闸门口径：源文件 ${srcFindings.length} 条 / 上限 ${BUDGET}；重复块 ${dupSrc.length} 条 / 上限 ${DUP_BUDGET}（两条棘轮，只许降不许升）。`,
  )
  console.log(
    `台账（RATCHET.json）：${ledgerCheck.entry ? `${ledgerCheck.version} 记账 ${ledgerCheck.entry.smells}/${ledgerCheck.entry.duplicates}` : '无本版记账行'}；${ledgerBad ? `${ledgerCheck.findings.length} 条不合规` : '合规'}`,
  )
  for (const f of ledgerCheck.findings) console.log(`  ✗ [${f.rule}] ${f.detail}`)
}
process.exit(STRICT && (overBudget || dupOverBudget || ledgerBad) ? 1 : 0)
