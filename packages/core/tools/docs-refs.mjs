#!/usr/bin/env node
/**
 * docs:refs（2026-11-27，3.5.4 尾巴）
 *
 * 交叉引用闸：文档里**指向别处**的话，必须真的指得到。
 * 起因是一次手工同步——`VERSION-PLAN` 两处写着「决策写入 `ARCH-MAP` 待裁决表」，
 * 而那张表根本不存在；`ARCH-MAP` 的版本路线还写着「27 条」，实际已经是 42 条。
 * 这两类错**都能被机器判**，却一直靠人翻。凡「靠人记得」的约定，等于大部分时候没做。
 *
 * 两类判据：
 *   1. `section-missing` / `doc-missing`：点名了文档的小节引用（`VERSION-PLAN.md §1.1`、
 *      `` [`X.md`](X.md) §待裁决 ``），目标文档必须存在且有对应标题。
 *      数字按标题编号比，中文按标题**包含**比。
 *   2. `plan-count`：`§1.7 … N 条` 的 N，必须等于该小节下任务表的实际行数。
 *      条数是最容易腐坏的数字——改排期时没人会回来数一遍。
 *
 * **只判点名了的引用**（2026-11-27 首跑教训）：
 * 裸写的 `§7` 在中文叙述里既可能指本文小节，也可能指「拆开前的那个技能的第 7 节」，
 * 机器无从分辨。首跑 329 条里九成是这种，判据当场失去可信度。
 * 规矩因此改成：**指别处就点名指谁**。裸引用不判，靠 review 时顺手补名。
 *
 * 不判：
 *   - 行号锚点（`file.mjs:123`）由 `legacy:audit` 管，这里不重复。
 *   - 跨仓链接、外部 URL、图片路径。
 *   - 「文档里的事实是否过时」（如某段描述已不成立）——那需要语义判断，机器只能到引用为止。
 *
 * 用法：
 *   node packages/core/tools/docs-refs.mjs            # 人读清单
 *   node packages/core/tools/docs-refs.mjs --json     # 机器读
 *   node packages/core/tools/docs-refs.mjs --strict   # 有问题则 exit 1（默认恒 0，只报不改）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROOT, docScope } from './lib/docs-scope.mjs'

const args = process.argv.slice(2)
const AS_JSON = args.includes('--json')
const STRICT = args.includes('--strict')

/**
 * **被引用面**比扫描面大：`RULES.md` 会指 `skills/focus-rules/SKILL.md`，
 * 那份不在 `docs/` 下，却实实在在是被引的一方。只按扫描面解析，就会把活的引用报成死引用。
 * 扫描面决定「查谁」，被引用面决定「能不能查到」——两件事，别混成一个清单。
 */
const UNIVERSE_SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.vs', '.focus-guard'])
function universe(dir = ROOT, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (UNIVERSE_SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) universe(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

const HEADING = /^(#{1,6})\s+(.+)$/
/** `1.7` / `2A`（安装指南的节号带字母）/ `4.5.3`。终止符放宽到 `.`、`、`，否则 `2A. 原生插件` 认不出来。 */
const NUMERIC_HEADING = /^(\d+[A-Za-z]?(?:\.\d+)*)(?:[\s.、]|$)/
/**
 * 小节名的合法字符：数字点号，或中文（含 〇）。
 * 中文分支要停在 `/`、`*`、`` ` ``、`|` 上——`§五/§六`、`§五·补**`、`§八/§九/§十`
 * 都是并列引用，吃进一个 token 就变成「没有这一节」的假红。
 */
const SECTION = /(\d+[A-Za-z]?(?:\.\d+)*|[\u4e00-\u9fa5\u3007][^\s，。、；：（）)」】「`|*/]*)/

/**
 * 文档名出现的三种写法，按**优先级**从左到右：
 *   `` [`X.md`](X.md) `` / `[X.md](X.md)`（链接，取 URL 目标）
 *   `` `X.md` ``（行内代码）
 *   `X.md`（裸写）
 * 首跑时只认第三种，于是 `` [`VERSION-PLAN.md`](VERSION-PLAN.md) §1.1 `` 被当成自引用，
 * 62 条问题里大半是这一种。
 */
const DOC_REF = /\[`?([^\]`\n]+?\.md)`?\]\(([^)\s]+?\.md)\)|`([^`\s]+\.md)`|((?:\.{1,2}\/)?[\w./-]+\.md)/g

/**
 * 往回找**最近**一个文档名。两条止损：
 *   - 隔太远不算：`README.md` 里「`INDEX.md` 里查不到它……以「HANDOFF §八」为锚点」，
 *     按「最近」会把 `INDEX.md` 认成 `§八` 的目标，报出「INDEX.md 里没有 §八」的假红。
 *   - 跨句不算：句号之后再出现的小节号，跟前面的文档名不是一回事。
 */
const MAX_GAP = 40
function nearestDoc(prefix) {
  let last = null
  for (const m of prefix.matchAll(DOC_REF)) last = m
  if (!last) return null
  const gap = prefix.slice(last.index + last[0].length)
  if (gap.length > MAX_GAP || /[。！？]/.test(gap)) return null
  return last[2] || last[3] || last[4]
}

/** 一份文档的标题索引：数字编号集合 + 标题全文数组（中文引用按包含比）。 */
export function indexHeadings(lines) {
  const ids = new Set()
  const titles = []
  for (const line of lines) {
    const m = line.match(HEADING)
    if (!m) continue
    titles.push(m[2].trim())
    const n = m[2].match(NUMERIC_HEADING)
    if (n) ids.add(n[1])
  }
  return { ids, titles }
}

/**
 * 任务表行数，按小节聚合。
 *
 * 归并靠**标题层级**，不靠编号深度：`### 1.7.1` 下面挂的 `#### 3.5.4` 是另一套编号，
 * 按编号深度出栈会把 `1.7.1` 直接弹掉，于是「§1.7 声明 42 条，实际 0 条」——
 * 首跑就是这么错的。层级才是真的包含关系，编号只是名字。
 *
 * 每个标题同时登记**全号**与**前两段**：`### 1.7.1` 既答 `§1.7.1`，也答 `§1.7`
 * （六档汇总写在 §1.7，明细表挂在 §1.7.1，两处说的是同一个 42）。
 *
 * 只数**「拆解」小节里的表行**：`### 1.7` 自己还有一张六档定档表（`| 1 | 3.5.4 | … |`），
 * 行数长得跟任务表一样，混进去就是 48 而不是 42。判据不是「有没有编号列」，
 * 而是「这张表是不是任务拆解」——文档里只有「每档任务拆解」这类小节在列任务。
 */
const TASK_SECTION = /拆解/
export function countTasks(lines) {
  const counts = new Map()
  const stack = []
  const keysOf = (num) => {
    const parts = num.split('.')
    return [...new Set([num, parts.slice(0, 2).join('.')])]
  }
  for (const line of lines) {
    const h = line.match(HEADING)
    if (h) {
      const level = h[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      const n = h[2].match(NUMERIC_HEADING)
      const keys = n ? keysOf(n[1]) : []
      stack.push({ level, keys, isTask: TASK_SECTION.test(h[2]) })
      for (const k of keys) if (!counts.has(k)) counts.set(k, 0)
      continue
    }
    if (!stack.some((s) => s.isTask)) continue
    // 只数任务表行：表头/分隔行/说明表都不是任务。
    if (!/^\|\s*\d+\s*\|/.test(line)) continue
    // 去重：`### 1.9` 与 `#### 1.9.1` 都登记了 `1.9`，逐项累加会把 12 条算成 24 条。
    const hit = new Set(stack.flatMap((s) => s.keys))
    for (const k of hit) counts.set(k, (counts.get(k) || 0) + 1)
  }
  return counts
}

/**
 * 文档名 → 实际文件。三级级联，因为仓里三种写法都在用：
 *   1. 相对本文（`../packages/core/docs/X.md`）—— 标准写法；
 *   2. 相对仓根（`docs/ARCHITECTURE.md`）—— 在 `docs/` 里的文档常这么写；
 *   3. 按文件名唯一命中（`VERSION-PLAN.md` 写在 `docs/` 里，实际在 `packages/core/docs/`）。
 * 第 3 级不管路径写法对不对，只管**指得到**——路径规范是 review 的事，死引用才是闸门的事。
 */
function makeResolver(files) {
  const byName = new Map()
  for (const f of files) {
    const base = f.split(/[\\/]/).pop()
    if (byName.has(base)) byName.set(base, null) // 重名就不猜
    else byName.set(base, f)
  }
  return (docPath, named) => {
    const rel = resolve(dirname(docPath), named)
    if (existsSync(rel)) return rel
    const atRoot = resolve(ROOT, named)
    if (existsSync(atRoot)) return atRoot
    // 后缀命中：`skills/focus-rules/SKILL.md` 对上 `packages/core/skills/focus-rules/SKILL.md`。
    // 仓里有三份 SKILL.md，只按文件名猜不出来，按路径尾巴就能。
    const tail = named.split('/').filter(Boolean).join('/')
    const hit = files.filter((f) => f.replace(/\\/g, '/').endsWith('/' + tail))
    if (hit.length === 1) return hit[0]
    const base = named.split('/').pop()
    return byName.get(base) || null
  }
}

function check(docPath, lines, allDocs, resolveDoc) {
  const problems = []
  const self = indexHeadings(lines)

  lines.forEach((line, i) => {
    for (let at = line.indexOf('§'); at !== -1; at = line.indexOf('§', at + 1)) {
      const namedDoc = nearestDoc(line.slice(0, at))
      const m = line.slice(at + 1).match(SECTION)
      if (!m) continue
      // 裸引用不判：中文叙述里的 `§` 多数不是引用，机器分不清，硬判会淹掉真问题。
      if (!namedDoc) continue
      const ref = m[1]
      const target = resolveDoc(docPath, namedDoc)
      if (!target) {
        problems.push({ rule: 'doc-missing', file: docPath, line: i + 1, detail: `引用了不存在的文档 ${namedDoc}` })
        continue
      }
      const idx = target === docPath ? self : allDocs.get(target)
      if (!idx) continue
      const ok = /^\d/.test(ref)
        ? idx.ids.has(ref)
        : idx.titles.some((t) => t.includes(ref) || ref.includes(t))
      if (!ok) {
        problems.push({
          rule: 'section-missing',
          file: docPath,
          line: i + 1,
          detail: `${namedDoc} 里没有 §${ref}`,
        })
      }
    }
  })
  return problems
}

/**
 * 「§1.7 … N 条」：条数声明必须与实际任务行数一致。
 * 三处止损，都来自首跑的假红：
 *   - `至少 3 条` 是粒度规矩，不是条数声明；
 *   - `合计 27 + 12 + 10 条` 是算式，取最后一个数会得出「§1.7 = 10 条」；
 *   - 隔着 40 字的「条」跟前面的 `§` 不是一回事。
 */
function checkCounts(docPath, lines, counts) {
  const problems = []
  const CLAIM = /^([^\n]{0,40}?)(\d+)\s*条/
  const NOT_A_CLAIM = /至少|≥|>=|\+|合计|累计/
  lines.forEach((line, i) => {
    // 逐个 `§` 独立判，不用 matchAll：`§1.7 定档 + §1.7.1 任务拆解（27 条）` 里
    // `§1.7` 因算式被跳过，但它会把游标带到「27 条」之后，于是 `§1.7.1` 的 27 永远查不到。
    for (let at = line.indexOf('§'); at !== -1; at = line.indexOf('§', at + 1)) {
      const rest = line.slice(at + 1)
      const sec = rest.match(/^(\d+(?:\.\d+)*)/)
      if (!sec) continue
      const claim = rest.slice(sec[0].length).match(CLAIM)
      if (!claim) continue
      const [, gap, claimed] = claim
      if (NOT_A_CLAIM.test(gap)) continue
      const actual = counts.get(sec[1])
      if (actual === undefined) continue // 该小节没有任务表，不是条数声明
      if (Number(claimed) !== actual) {
        problems.push({
          rule: 'plan-count',
          file: docPath,
          line: i + 1,
          detail: `§${sec[1]} 声明 ${claimed} 条，实际 ${actual} 条`,
        })
      }
    }
  })
  return problems
}

function main() {
  const files = docScope().filter((f) => {
    try {
      return statSync(f).size < 2 * 1024 * 1024
    } catch {
      return false
    }
  })

  // 标题索引建在**被引用面**上：引用可以指向 `docs/` 之外（如 `skills/*/SKILL.md`），
  // 只索引扫描面会让这些活引用变成「文档不存在」。
  const allDocs = new Map()
  const bodies = new Map()
  const targets = universe().filter((f) => {
    try {
      return statSync(f).size < 2 * 1024 * 1024
    } catch {
      return false
    }
  })
  for (const f of targets) {
    // 必须吃掉 `\r`：`\r` 不属于 `.`，`^(#{1,6})\s+(.+)$` 对 CRLF 文件一行都匹配不上，
    // 标题索引整个为空，于是每处引用都报「本文里没有这一节」——首跑 329 条的主要来源之一。
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    bodies.set(f, lines)
    allDocs.set(f, indexHeadings(lines))
  }

  // 任务条数只在计划文档上算：别处的「N 条」是叙述，不是排期。
  const planPath = files.find((f) => f.endsWith('VERSION-PLAN.md'))
  const counts = planPath ? countTasks(bodies.get(planPath)) : new Map()

  const problems = []
  const resolveDoc = makeResolver(targets)
  for (const f of files) {
    problems.push(...check(f, bodies.get(f), allDocs, resolveDoc))
    problems.push(...checkCounts(f, bodies.get(f), counts))
  }

  const rel = (p) => relative(ROOT, p).split('\\').join('/')
  if (AS_JSON) {
    console.log(JSON.stringify({ files: files.length, problems: problems.map((p) => ({ ...p, file: rel(p.file) })) }, null, 1))
  } else {
    console.log(`[docs:refs] 扫描 ${files.length} 份文档 → 问题 ${problems.length} 条`)
    for (const p of problems) console.log(`${rel(p.file)}:${p.line} [${p.rule}] ${p.detail}`)
    if (!problems.length) console.log('  引用与条数都对得上。')
  }
  return STRICT && problems.length > 0 ? 1 : 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit(main())
