#!/usr/bin/env node
/**
 * 模块体检（2026-10-25）
 * 输出：每个模块的行数/导出符号/TODO/空 catch/console 调用；测试覆盖线索。
 * 只读，不改代码。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walk } from './lib/import-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..')
const ROOTS = ['src/core', 'src/adapters/dsh', 'src/dsh', 'hooks', 'tools', 'tests']

const files = ROOTS.flatMap((r) => walk(join(CORE, r)))
const rows = []
for (const f of files) {
  const rel = relative(CORE, f).replace(/\\/g, '/')
  const src = readFileSync(f, 'utf8')
  const lines = src.split('\n').length
  const exports = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  const todos = (src.match(/TODO|FIXME|XXX|HACK/g) || []).length
  const emptyCatch = (src.match(/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[^*]*\*\/)?\s*\}/g) || []).length
  const consoleCalls = (src.match(/console\.(log|warn|error|info)\(/g) || []).length
  rows.push({ rel, lines, exports: exports.length, todos, emptyCatch, consoleCalls })
}

rows.sort((a, b) => b.lines - a.lines)
console.log('模块'.padEnd(46) + '行'.padStart(6) + '导出'.padStart(5) + 'TODO'.padStart(6) + '空catch'.padStart(8) + 'console'.padStart(8))
for (const r of rows) {
  console.log(
    r.rel.padEnd(42) +
      String(r.lines).padStart(6) +
      String(r.exports).padStart(5) +
      String(r.todos).padStart(6) +
      String(r.emptyCatch).padStart(8) +
      String(r.consoleCalls).padStart(8),
  )
}
console.log(`\n合计 ${rows.length} 个文件，${rows.reduce((a, r) => a + r.lines, 0)} 行`)
