/**
 * import 图（tools/lib/import-graph.mjs，2026-10-27）。
 *
 * 为什么抽出来：`tools/health.mjs`（算可达性）与 `tools/mutate.mjs`（选测试文件）
 * 需要**同一张图**。同一段逻辑写两遍必然分叉——本仓已经栽过一次：`stripLiterals`
 * 各写一份，smells 那份漏了正则字面量，把 398 行的函数抹成 0。
 *
 * 三种引用形态都必须认，否则"没引用"就是假阴性：
 *   ① `import x from './a.mjs'`
 *   ② `await import('./a.mjs')`
 *   ③ `fileURLToPath(new URL('../src/a.mjs', import.meta.url))` ← 跑 CLI 的测试只拼路径，不 import
 *
 * 这里**刻意不用** `stripLiterals`：它会把字符串内容抹成空格，而 import 的路径就在字符串里。
 * 去字面量是给"查运算符"用的，不是给"查路径"用的。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g

export function walk(dir, out = []) {
  let entries
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
    else if (/\.(mjs|cjs|js)$/.test(e)) out.push(p)
  }
  return out
}

/** 把 `./x.mjs` 这类相对说明符解析成绝对路径（补后缀、试 index）。非相对返回 null。 */
export function resolveSpec(fromFile, spec) {
  if (!spec || !spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js')]) {
    try {
      if (statSync(cand).isFile()) return cand
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/**
 * 建图。
 *
 * @param {string} repoRoot
 * @returns {{
 *   srcDir: string, srcFiles: string[], testFiles: string[], frozenFiles: string[],
 *   depsOf: (f: string) => string[],
 *   reachFrom: (seeds: string[]) => Set<string>,
 *   reachingTests: (srcFile: string) => string[],
 * }}
 */
export function buildImportGraph(repoRoot) {
  const srcDir = join(repoRoot, 'packages/core/src')
  const srcFiles = walk(srcDir)
  const srcSet = new Set(srcFiles)
  const testFiles = walk(join(repoRoot, 'packages/core/tests')).filter((f) => f.endsWith('.test.mjs'))
  const frozenFiles = walk(join(repoRoot, 'packages/core/hooks'))

  const cache = new Map()
  const depsOf = (file) => {
    if (cache.has(file)) return cache.get(file)
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      /* 读不到就当无边 */
    }
    const out = []
    for (const m of text.matchAll(IMPORT_RE)) {
      const r = resolveSpec(file, m[1] || m[2] || m[3])
      if (r && srcSet.has(r)) out.push(r)
    }
    cache.set(file, out)
    return out
  }

  const reachFrom = (seeds) => {
    const reached = new Set()
    const queue = []
    const push = (f) => {
      if (srcSet.has(f) && !reached.has(f)) {
        reached.add(f)
        queue.push(f)
      }
    }
    for (const s of seeds) for (const d of depsOf(s)) push(d)
    while (queue.length) for (const d of depsOf(queue.pop())) push(d)
    return reached
  }

  // 反向索引：src 模块 ← 触达它的测试文件。变异测试靠这个选测试，不必跑全量。
  let reverse = null
  const reachingTests = (srcFile) => {
    if (!reverse) {
      reverse = new Map()
      for (const t of testFiles) {
        for (const s of reachFrom([t])) {
          if (!reverse.has(s)) reverse.set(s, [])
          reverse.get(s).push(t)
        }
      }
    }
    return reverse.get(srcFile) || []
  }

  return { srcDir, srcFiles, testFiles, frozenFiles, depsOf, reachFrom, reachingTests }
}

/** 相对 `src/` 的展示路径（报告里用绝对路径没法读）。 */
export function relToSrc(srcDir, file) {
  return relative(srcDir, file).replace(/\\/g, '/')
}
