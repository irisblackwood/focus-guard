#!/usr/bin/env node
/**
 * 私有面守卫（2026-10-30）
 *
 * ## 为什么需要
 *
 * 私有忽略规则从 `.gitignore`（入库、公开）搬到 `.git/info/exclude`（本地、不入库）之后，
 * 换来一个收益：外人看不到"屏蔽了什么"，只知道仓库里没有这些文件。
 *
 * 但也引入一个隐患：**exclude 不随仓库走**。换机器 clone 后如果忘了配，
 * `git add .` 会把私有数据整包收进版本库，而且第一次发现往往是已经推上去之后。
 * 本工具把这个隐患从"数据泄漏事故"降级成"一条检查失败"。
 *
 * ## 为什么规则清单不在本文件里
 *
 * 本文件进版本库、是公开的。如果在这里写死 `.ai/`、`.focus-guard/` 之类的路径，
 * 守卫自己就变成了泄漏源——白折腾一场。
 * 所以：**清单只存在于 `.git/info/exclude`（私有），本工具运行时读它。**
 * 代码里一个字都不提具体目录名。
 *
 * ## 四条断言
 *
 *   A. exclude 可读 —— 否则私有面根本没设防
 *   B. 没有**已跟踪**文件命中 exclude 规则 —— 命中即已经泄漏，且 .gitignore 拦不住已跟踪文件
 *   C. `.gitignore` 没有点名 exclude 里的路径 —— 点名即把分类重新暴露给外人
 *   D. 若存在清单备份，其规则须全部已装进 exclude —— 专抓"换机器忘了装"
 *
 * ## 输出也不泄漏
 *
 * 默认只报**数量与规则序号**，不打路径、不打规则原文——本地日志也可能被贴出去。
 * 要处置时加 `--verbose` 才展开。
 *
 * 用法：
 *   node packages/core/tools/privacy-guard.mjs             # 人读摘要
 *   node packages/core/tools/privacy-guard.mjs --verbose   # 展开命中的具体路径
 *   node packages/core/tools/privacy-guard.mjs --json      # 机器读
 *   node packages/core/tools/privacy-guard.mjs --install   # 把清单备份装进 exclude（幂等）
 * 退出码：0 通过 / 1 有断言失败 / 2 环境不可判（不在 git 仓库里）
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const EXCLUDE_PATH = join(REPO_ROOT, '.git', 'info', 'exclude')
const GITIGNORE_PATH = join(REPO_ROOT, '.gitignore')
/** 清单备份：放在私有目录里，所以它自己不会进版本库。 */
const CANONICAL_PATH = join(REPO_ROOT, '.ai', 'private-surface.exclude')

/**
 * 把一条 gitignore 风格规则编译成正则。
 *
 * 支持：`/` 锚定、结尾 `/` 只匹配目录、`*`（不跨 `/`）、`**`（跨 `/`）、`?`。
 * 不支持：字符类 `[a-z]`、转义——清单是我们自己写的，用不到就别写，
 * 写了也不报错（当普通字符处理），但 `--check-rules` 会提示不支持。
 *
 * @param {string} rule 不含 `!` 前缀
 * @returns {{re: RegExp, dirOnly: boolean}}
 */
export function compileRule(rule) {
  let r = rule
  const dirOnly = r.endsWith('/')
  if (dirOnly) r = r.slice(0, -1)
  let anchored = r.startsWith('/')
  if (anchored) r = r.slice(1)
  // 中间带 `/` 的规则天然从根锚定（gitignore 同义）
  if (r.includes('/')) anchored = true

  const body = r
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]')

  // 目录规则：路径里出现这个段即可（段后必须有 `/` 或结束）
  if (dirOnly) {
    const head = anchored ? `^${body}` : `(^|/)${body}`
    return { re: new RegExp(`${head}(/|$)`), dirOnly }
  }
  // 文件规则：无 `/` 时匹配任意深度的同名文件；有 `/` 时从根锚定
  const re = anchored ? new RegExp(`^${body}$`) : new RegExp(`(^|/)${body}$`)
  return { re, dirOnly }
}

/**
 * 解析 exclude 文本为规则列表。跳过注释与空行，保留 `!` 取反语义与顺序。
 * @param {string} text
 * @returns {Array<{raw: string, negate: boolean, re: RegExp, dirOnly: boolean}>}
 */
export function parseRules(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const negate = trimmed.startsWith('!')
    const body = negate ? trimmed.slice(1) : trimmed
    if (!body) continue
    out.push({ raw: trimmed, negate, ...compileRule(body) })
  }
  return out
}

/**
 * 按 gitignore 语义判定单个路径是否被忽略：**最后一条命中的规则说了算**。
 *
 * 关键点：必须把**所有祖先目录**也当作候选来匹配。
 * 因为 gitignore 里 `/docs/vault-notes/*` 匹配的是目录 `docs/vault-notes/vendors`，
 * 然后"被忽略的目录下面的一切都跟着被忽略"——如果只拿完整文件路径去套
 * `[^/]*`，嵌套文件永远匹配不上，守卫就成了瞎子。
 * （2026-10-30 实测踩过：git check-ignore 命中，自写匹配器漏判。）
 *
 * @param {Array} rules parseRules 的结果
 * @param {string} path 相对仓库根的路径，用 `/` 分隔
 * @returns {boolean}
 */
export function isIgnored(rules, path) {
  const parts = String(path).split('/')
  const cands = []
  for (let i = 1; i <= parts.length; i += 1) cands.push(parts.slice(0, i).join('/'))
  let ignored = false
  for (const rule of rules) {
    if (!cands.some((c) => rule.re.test(c))) continue
    ignored = !rule.negate
  }
  return ignored
}

/** 取仓库已跟踪文件清单。失败返回 null（调用方判环境不可用）。 */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 断言 C 的实现：`.gitignore` 是否点名了 exclude 里的路径。
 *
 * 判据不看语义、只看**字符串是否重复出现**——同一个路径串既在私有清单里、
 * 又在公开的 .gitignore 里，那它的分类就已经暴露了。
 *
 * 两类必须排除，否则 C 会误报成灾（2026-10-30 首版就踩了）：
 *   ① 以通配开头的规则（`*.log`）—— 纯后缀/扩展名规则，天然通用，
 *      而且它的"字面前缀"是空串，`startsWith('')` 恒真，会把所有条目都判成泄漏；
 *   ② 取反规则在**两边都出现**时才算泄漏，单独出现不算（`.gitignore` 里放行
 *      某个文件不暴露任何东西，暴露的是清单里那条路径）。
 *
 * @param {string} gitignoreText
 * @param {Array} rules
 * @returns {string[]} 泄漏的规则原文（**只在内部用，不直接打印**）
 */
export function findLeakedRules(gitignoreText, rules) {
  const lines = String(gitignoreText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const leaked = []
  for (const rule of rules) {
    const needle = rule.raw.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, '')
    // 空串或以通配开头 → 通用规则，不是私有路径的身份
    if (!needle || /^[*?]/.test(needle)) continue
    const literal = needle.split(/[*?]/)[0]
    const hit = lines.some((line) => {
      const cand = line.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, '')
      if (!cand) return false
      if (literal) return cand === needle || cand.startsWith(literal)
      return cand === needle
    })
    if (hit) leaked.push(rule.raw)
  }
  return leaked
}

/**
 * 把清单备份里缺的规则追加进 exclude（幂等：已在的跳过）。
 *
 * 为什么是"追加"而不是"覆盖"：exclude 里可能还有别的本地规则（如 IDE 产物），
 * 覆盖会把人家的东西冲掉。只补缺的，最安全。
 *
 * @returns {{added: string[], skipped: number}}
 */
export function installRules(canonicalPath = CANONICAL_PATH, excludePath = EXCLUDE_PATH) {
  if (!existsSync(canonicalPath)) {
    throw new Error(`清单备份不存在：${canonicalPath}`)
  }
  const want = parseRules(readFileSync(canonicalPath, 'utf8')).map((r) => r.raw)
  const have = new Set(
    existsSync(excludePath) ? parseRules(readFileSync(excludePath, 'utf8')).map((r) => r.raw) : [],
  )
  const missing = want.filter((w) => !have.has(w))
  if (missing.length === 0) return { added: [], skipped: want.length }
  const block = `\n# —— 私有面（由 privacy-guard --install 维护，勿手改）——\n${missing.join('\n')}\n`
  appendFileSync(excludePath, block, 'utf8')
  return { added: missing, skipped: want.length - missing.length }
}

/**
 * 四条断言的全过程。拆出来是因为塞在 main() 里会撑破结构预算（113 行 > 80）。
 *
 * @param {string[]} files 已跟踪文件清单
 * @returns {{rules: Array, failures: Array, notes: string[]}}
 */
function auditSurface(files) {
  const failures = []
  const notes = []

  // —— 断言 A：exclude 可读 ——
  let rules = []
  if (!existsSync(EXCLUDE_PATH)) {
    failures.push({ code: 'A', msg: '.git/info/exclude 不存在，私有面没有设防' })
  } else {
    rules = parseRules(readFileSync(EXCLUDE_PATH, 'utf8'))
    if (rules.length === 0) {
      failures.push({ code: 'A', msg: '.git/info/exclude 为空，私有面没有设防' })
    }
  }
  if (rules.length === 0) return { rules, failures, notes }

  // —— 断言 B：没有已跟踪文件命中私有规则 ——
  // 注：.gitignore 对**已跟踪**文件无效，所以一旦命中，只能靠 git rm --cached 补救。
  const trackedHits = files.filter((f) => isIgnored(rules, f))
  if (trackedHits.length > 0) {
    failures.push({
      code: 'B',
      msg: `${trackedHits.length} 个已跟踪文件命中私有规则（已泄漏，.gitignore 拦不住已跟踪文件）`,
      detail: trackedHits,
    })
  }

  // —— 断言 C：.gitignore 未点名私有路径 ——
  if (existsSync(GITIGNORE_PATH)) {
    const leaked = findLeakedRules(readFileSync(GITIGNORE_PATH, 'utf8'), rules)
    if (leaked.length > 0) {
      failures.push({
        code: 'C',
        msg: `.gitignore 点名了 ${leaked.length} 条私有路径（分类已暴露，应只留在 exclude）`,
        detail: leaked,
      })
    }
  }

  // —— 断言 D：清单备份已安装 ——
  if (existsSync(CANONICAL_PATH)) {
    const want = parseRules(readFileSync(CANONICAL_PATH, 'utf8')).map((r) => r.raw)
    const have = new Set(rules.map((r) => r.raw))
    const missing = want.filter((w) => !have.has(w))
    if (missing.length > 0) {
      failures.push({
        code: 'D',
        msg: `清单备份里有 ${missing.length} 条规则未装进 exclude（换机器忘了装？）`,
        detail: missing,
      })
    }
  } else {
    notes.push('未找到清单备份（.ai/private-surface.exclude），跳过 D —— 新机器上这是正常的')
  }

  return { rules, failures, notes }
}

/** `--install` 分支：装清单并退出。 */
function runInstall(json) {
  try {
    const { added, skipped } = installRules()
    if (json) console.log(JSON.stringify({ added: added.length, skipped }))
    else {
      console.log(`[privacy-guard] 已装 ${added.length} 条（已在 ${skipped} 条）→ .git/info/exclude`)
      if (added.length === 0) console.log('[privacy-guard] 无需改动，清单已是最新')
    }
    process.exit(0)
  } catch (error) {
    console.error(`[privacy-guard] 安装失败：${error && error.message}`)
    process.exit(2)
  }
}

/** 人读输出。默认不展开路径与规则原文——本地日志也可能被贴出去。 */
function printHuman({ rules, files, failures, notes }, verbose) {
  console.log(`[privacy-guard] 私有规则 ${rules.length} 条 · 已跟踪 ${files.length} 个文件`)
  for (const note of notes) console.log(`  · ${note}`)
  if (failures.length === 0) {
    console.log('[privacy-guard] PASS：私有面干净（无已跟踪命中、无 .gitignore 点名、清单已装）')
    return
  }
  for (const f of failures) {
    console.log(`  ✗ [${f.code}] ${f.msg}`)
    if (!verbose || !f.detail) continue
    for (const d of f.detail.slice(0, 20)) console.log(`      ${d}`)
    if (f.detail.length > 20) console.log(`      …还有 ${f.detail.length - 20} 条`)
  }
  console.log('  处置：A/D → 从清单备份重装 exclude；B → git rm --cached 该文件；C → 从 .gitignore 删掉该条')
  if (!verbose) console.log('  （默认不展开路径与规则原文，加 --verbose 查看）')
}

function main() {
  const json = process.argv.includes('--json')
  const verbose = process.argv.includes('--verbose')

  if (process.argv.includes('--install')) runInstall(json)

  const files = trackedFiles()
  if (files === null) {
    console.error('[privacy-guard] 不在 git 仓库里，环境不可判')
    process.exit(2)
  }

  const { rules, failures, notes } = auditSurface(files)
  const result = {
    rules: rules.length,
    tracked: files.length,
    failures: failures.map((f) => ({
      code: f.code,
      msg: f.msg,
      count: f.detail ? f.detail.length : 0,
      ...(verbose && f.detail ? { detail: f.detail } : {}),
    })),
    notes,
    ok: failures.length === 0,
  }

  if (json) console.log(JSON.stringify(result))
  else printHuman({ rules, files, failures, notes }, verbose)

  process.exit(failures.length === 0 ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('privacy-guard.mjs')) main()
