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
}

/**
 * 债务上限（棘轮）：源文件异味不许超过这个数。降存量后手工下调，不许反弹。
 * 现状 8 条（2026-10-27 从 28 降下来：seams/preGuard/stopGuard/postProgress/guard/* 均已拆）。
 */
const BUDGET = 8

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

const findings = []
const files = ROOTS.flatMap((r) => walk(r))

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
const byKind = {}
for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1

if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, thresholds: THRESHOLDS, byKind, srcFindings, testFindings, budget: BUDGET }, null, 2))
} else if (BRIEF) {
  const parts = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
  const gate = srcFindings.length > BUDGET ? `❌ 超上限 ${BUDGET}` : `✅ 上限 ${BUDGET}`
  console.log(
    `结构异味：${files.length} 文件，源文件 ${srcFindings.length} 条（${gate}）/ 测试 ${testFindings.length} 条${parts.length ? `（${parts.join(' / ')}）` : ''}`,
  )
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
  console.log('\n不报 todo-density：它分不出「已申报的空头条款」与「遗忘的债」。查空头条款用 npm run quality:audit。')
  console.log(`闸门口径：源文件 ${srcFindings.length} 条 / 上限 ${BUDGET}（棘轮，只许降不许升）。`)
}
process.exit(STRICT && srcFindings.length > BUDGET ? 1 : 0)
