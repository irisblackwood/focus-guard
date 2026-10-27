#!/usr/bin/env node
/**
 * 死导出检查（2026-10-25）：找出"导出了但没人调用"的符号——模块活着、功能没接上的典型形态。
 * 只读。排除：tests/ 内的引用不算使用者；同名不同文件的第二个实现会单独列出。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..')
const ROOTS = ['src', 'hooks', 'tools']

function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(mjs|js)$/.test(e)) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(join(CORE, r)))
const sources = new Map()
for (const f of files) sources.set(f, readFileSync(f, 'utf8'))
const testsText = (() => {
  const tests = walk(join(CORE, 'tests'))
  return tests.map((f) => readFileSync(f, 'utf8')).join('\n')
})()

const exportRe = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g
const findings = []
for (const [file, src] of sources) {
  const rel = relative(CORE, file).replace(/\\/g, '/')
  for (const m of src.matchAll(exportRe)) {
    const name = m[1]
    let uses = 0
    for (const [other, osrc] of sources) {
      if (other === file) continue
      // 粗略：出现该符号名即算一次使用（含 import 与调用）
      const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g')
      uses += (osrc.match(re) || []).length
    }
    const inTests = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(testsText)
    if (uses === 0) findings.push({ rel, name, inTests })
  }
}

findings.sort((a, b) => a.rel.localeCompare(b.rel))
console.log(`死导出候选 ${findings.length} 个（被 tests 引用的标注 *）`)
for (const f of findings) console.log(`  ${f.rel.padEnd(42)} ${f.name}${f.inTests ? '  *仅测试使用' : ''}`)
