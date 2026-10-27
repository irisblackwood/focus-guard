#!/usr/bin/env node
/**
 * 房规检查器（tools/lint.mjs，2026-10-27）——内置化第一件，零依赖。
 *
 * 为什么自己写：
 *   上一轮用 `dsh-code-check` 的 ESLint fallback 配置跑，得出 **775 warnings**，
 *   但其中 `curly` 589 条全是本仓房规（单语句块不加大括号），不是缺陷。
 *   它的评分模型 `100 − errors×8 − warnings×3` 代入后直接封底 0/100——
 *   **一个把房规算成缺陷的尺子，量出来的是尺子自己**。
 *
 * 本工具只报"确定是问题"的五类，不报风格：
 *   unused-import     导入了但全文没用到（死代码，会骗读者以为有依赖）
 *   duplicate-import  同一模块被 import 两次（合并后易读，且 no-duplicate 是硬错）
 *   var               应 let/const（函数作用域陷阱，非块级）
 *   loose-equal       `==`/`!=` 且两侧都不是 null/undefined（隐式转换）
 *   console-in-src    `console.log` 留在 `src/core/` 或 `src/adapters/`（污染输出，测试里允许）
 *
 * `console-in-src` 只查母版与适配层，**不查 `src/dsh/`**（2026-10-27 修注释）：
 * 分层纪律是"母版是逻辑，适配层只做翻译，打印属宿主职责"。宿主缝里 `status.mjs`
 * 这类 CLI 本来就要往 stdout 写，算成污染是错的。原注释写成"留在 src/"，与实现不符——
 * **注释与实现不一致时，先信实现，再改注释**。
 *
 * 明确**不报**的三类（各自有理由）：
 *   curly            房规。单语句块不加括号，全仓一致
 *   `== null`        惯用法，同时匹配 null 与 undefined；改 `===` 会漏掉 undefined
 *   空 catch          FG 的空 catch 是环境探测/清理路径的三级兜底，有意为之
 *
 * 用法：
 *   node packages/core/tools/lint.mjs              # 明细
 *   node packages/core/tools/lint.mjs --brief      # 一行（供 npm run check）
 *   node packages/core/tools/lint.mjs --json
 *   node packages/core/tools/lint.mjs --strict     # 超债务上限 exit 1
 *   node packages/core/tools/lint.mjs <目录...>    # 只扫指定目录
 *
 * 退出码：默认恒 0（只报不改）；`--strict` 时**活跃层问题数 > BUDGET** 才 exit 1。
 *
 * 为什么是"债务上限"而不是"有问题就红"（2026-10-27 改）：
 *   首版 `--strict` = 有任何一条就 exit 1。当前 54 条全在已封存的 `hooks/`（不维护），
 *   那条闸门**永远红**。永久红会训练人忽略告警——`schema:verify` 上已经踩过同一个坑。
 *   所以：① 闸门只看活跃层（src/tools/tests），`hooks/` 只报不计；② 活跃层上限为 0，
 *   新增一条就红；③ 修好了不许反弹（存量降下来时手工把 BUDGET 往下调）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 去字面量与注释：与 smells.mjs 共用同一实现（2026-10-27 抽到 tools/lib/）。
// 各写一份必然分叉——smells 那份就漏了正则字面量，把 398 行的函数抹成 0。
import { stripLiterals } from './lib/source-text.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 仓库根可覆盖：测试要造夹具目录跑真扫描，否则这个工具自己没被测量。
// 与 FG_AUDIT_FILE 同一思路——**测试必须能把被测对象指到别处**。
const REPO = process.env.FG_REPO_ROOT ? resolve(process.env.FG_REPO_ROOT) : resolve(HERE, '../../..')

const argv = process.argv.slice(2)
const BRIEF = argv.includes('--brief')
const AS_JSON = argv.includes('--json')
const STRICT = argv.includes('--strict')
const dirArgs = argv.filter((a) => !a.startsWith('--'))

const DEFAULT_ROOTS = ['packages/core/src', 'packages/core/tools', 'packages/core/tests', 'packages/core/hooks', 'packages/extended/src']
const roots = (dirArgs.length ? dirArgs : DEFAULT_ROOTS).map((d) => resolve(REPO, d))

/**
 * 债务上限（棘轮）。只对**活跃层**计数：`hooks/` 已封存不维护，不计入闸门。
 * 现状活跃层 0 条 —— 所以上限就是 0，新增一条即红。降存量后手工下调，不许反弹。
 */
const BUDGET = 0
const GATED = /^packages\/(core\/(src|tools|tests)|extended\/src)\//

const SKIP_DIRS = new Set(['node_modules', '.git', '.stryker-tmp', '.mutate-tmp', 'reports', '.ai'])

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

/**
 * 解析 import 语句：返回 [{ start, end, source, names: [{ local, imported }] }]。
 * 手写状态机而非正则一把梭——本仓有多行具名 import（`import {\n A,\n B,\n} from 'x'`），
 * 单行正则会把它们截断，进而把"已使用的符号"误报成未使用。
 */
function parseImports(src) {
  const lines = src.split('\n')
  const out = []
  let buf = null
  let startLine = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (buf === null) {
      // 排除 `import(` 动态导入与缩进的 `import.meta`
      if (/^\s*import\s+[^(]/.test(line) || /^\s*import\s*['"]/.test(line)) {
        buf = line
        startLine = i
      } else continue
    } else {
      buf += '\n' + line
    }
    if (/from\s*['"][^'"]+['"]/.test(buf) || /^\s*import\s*['"][^'"]+['"]/.test(buf)) {
      const m = buf.match(/from\s*['"]([^'"]+)['"]/)
      const sideEffect = buf.match(/^\s*import\s*['"]([^'"]+)['"]/)
      const source = m ? m[1] : sideEffect ? sideEffect[1] : ''
      out.push({ start: startLine, end: i, source, names: parseNames(buf) })
      buf = null
    }
  }
  return { list: out, lines }
}

/** 从一段 import 语句里取绑定名（本地名）。 */
function parseNames(stmt) {
  const names = []
  const clause = stmt.replace(/^\s*import\s*/, '').replace(/from\s*['"][^'"]+['"][\s;]*$/, '').replace(/^\s*['"][^'"]+['"][\s;]*$/, '')
  // 具名部分
  const brace = clause.match(/\{([\s\S]*?)\}/)
  if (brace) {
    for (const part of brace[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)/)
      const imported = t.replace(/\s+as\s+[\w$]+$/, '').trim()
      const local = as ? as[1] : imported
      if (local) names.push({ local, imported })
    }
  }
  // 默认导入与命名空间
  const head = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, ' ').trim()
  for (const tok of head.split(/\s+/)) {
    if (!tok || tok === 'import') continue
    if (tok === 'as' || tok === '*') continue
    if (/^[A-Za-z_$][\w$]*$/.test(tok)) names.push({ local: tok, imported: tok })
  }
  return names
}

const RULES = {
  'unused-import': '导入后全文未使用（死代码）',
  'duplicate-import': '同一模块被 import 多次',
  var: '使用 var（应 let/const）',
  'loose-equal': '使用 == / !=（两侧均非 null/undefined）',
  'console-in-src': 'console.log 留在 src/（污染输出）',
}

const findings = []

function report(file, line, rule, detail) {
  findings.push({ file: relative(REPO, file).replace(/\\/g, '/'), line, rule, detail })
}

/** 未使用 import：把 import 段从源码剔除后再数出现次数，避免把导入本身算成使用。 */
function checkImports(file, src) {
  const { list, lines } = parseImports(src)
  const seen = new Map()
  for (const imp of list) {
    if (imp.source) seen.set(imp.source, (seen.get(imp.source) || 0) + 1)
  }
  for (const [source, n] of seen) {
    if (n > 1) report(file, list.find((i) => i.source === source).start + 1, 'duplicate-import', `${source} 被 import ${n} 次`)
  }

  // 剔除所有 import 语句后的剩余正文
  const keep = []
  const dropRanges = list.map((i) => [i.start, i.end])
  for (let i = 0; i < lines.length; i += 1) {
    if (dropRanges.some(([s, e]) => i >= s && i <= e)) continue
    keep.push(lines[i])
  }
  const body = keep.join('\n')

  for (const imp of list) {
    for (const { local } of imp.names) {
      // 只保留 ASCII 标识符边界，避免中文注释里的同名字串误判
      const re = new RegExp(`(?<![\\w$])${local.replace(/\$/g, '\\$')}(?![\\w$])`)
      if (!re.test(body)) report(file, imp.start + 1, 'unused-import', `${local}（来自 ${imp.source}）`)
    }
  }
}

/** var：跑在去字面量后的文本上，避免 `var ` 出现在字符串里被误报。 */
function checkVar(file, plain) {
  const lines = plain.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (/(^|[;{}]\s*)var\s+[A-Za-z_$[]/.test(lines[i])) {
      report(file, i + 1, 'var', lines[i].trim().slice(0, 60))
    }
  }
}

/** 宽松相等：`== null` / `!= null` 是本仓惯用法（同时匹配 null 与 undefined），明确放行。 */
function checkLooseEqual(file, plain) {
  const lines = plain.split('\n')
  // 2026-10-27 首版踩坑两次：① `[^=!<>]!?==[^=]` 把 `!==` 吃进去（报 98 条）；
  // ② 改成 `(?<![=!<>])[!=]==(?!=)` 后 `[!=]` 仍能匹配 `=`，于是 `===` 又被吃进去（报 545 条）。
  // **宽松相等的对手是严格相等**，必须精确锚定成 `==` 或 `!=`：第一个字符 `[!=]`，
  // 第二个字符 `=`，且其后不能再接 `=`。用样本测过再上线，不靠眼读。
  const RE = /(?<![=!<>])[!=]=(?!=)/g
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    let hit
    RE.lastIndex = 0
    while ((hit = RE.exec(line))) {
      const around = line.slice(Math.max(0, hit.index - 12), hit.index + 14)
      if (/\bnull\b|\bundefined\b/.test(around)) continue // 惯用法，放行
      report(file, i + 1, 'loose-equal', line.trim().slice(0, 60))
      break
    }
  }
}

/**
 * console.log 留在不该打印的层。
 *
 * 只查 `src/core/` 与 `src/adapters/`：母版是纯判定、适配层只做翻译，两者都不该往 stdout 写。
 * `src/dsh/` 里有 CLI 入口（`status.mjs` 就是渲染命令输出的），报它没有意义。
 */
function checkConsole(file, plain) {
  const rel = relative(REPO, file).replace(/\\/g, '/')
  if (!/^packages\/core\/src\/(core|adapters)\//.test(rel)) return
  const lines = plain.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (/\bconsole\.(log|debug|info)\s*\(/.test(lines[i])) report(file, i + 1, 'console-in-src', lines[i].trim().slice(0, 60))
  }
}

const files = roots.flatMap((r) => walk(r))
for (const file of files) {
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const plain = stripLiterals(src)
  checkImports(file, src)
  checkVar(file, plain)
  checkLooseEqual(file, plain)
  checkConsole(file, plain)
}

const byRule = {}
for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1

// 闸门只数活跃层；封存的 hooks/ 与 extended 之外一律不计
const gated = findings.filter((f) => GATED.test(f.file.replace(/\\/g, '/')))
const frozen = findings.length - gated.length

if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, findings, byRule, gated: gated.length, budget: BUDGET }, null, 2))
} else if (BRIEF) {
  const parts = Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${n}`)
  const gate = gated.length > BUDGET ? `活跃层 ${gated.length} 条 > 上限 ${BUDGET} ❌` : `活跃层 ${gated.length}/${BUDGET} ✅`
  console.log(`房规检查：${files.length} 文件，问题 ${findings.length} 条${parts.length ? `（${parts.join(' / ')}）` : ''}；${gate}${frozen ? `，封存层 ${frozen} 条不计` : ''}`)
} else {
  console.log(`房规检查：${files.length} 文件，问题 ${findings.length} 条\n`)
  if (!findings.length) console.log('无问题。')
  for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`${f.file}:${f.line}\t[${f.rule}] ${f.detail}`)
  }
  console.log('\n不报的三类（各有理由）：curly 房规 / `== null` 惯用法 / 空 catch 三级兜底。')
  console.log(`闸门口径：活跃层 ${gated.length} 条 / 上限 ${BUDGET}；封存层 ${frozen} 条（hooks/）只报不计。`)
}
process.exit(STRICT && gated.length > BUDGET ? 1 : 0)
