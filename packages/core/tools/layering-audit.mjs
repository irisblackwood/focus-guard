#!/usr/bin/env node
/**
 * 分层泄漏审计（2026-10-22）
 *
 * 方向纪律（`tests/layering.test.mjs` 已锁 import 方向）：
 *   core（母版，与宿主无关） → adapter（各宿主映射） → seam（DSH 挂接/组装根）
 * 但 import 方向对了，**内容**仍可能越界：母版里写死某个宿主的工具名/事件名/环境变量，
 * 等于让母版替宿主代言 —— 换宿主就要改母版。
 *
 * 本工具只读扫描，输出三类问题：
 *   A 母版（src/core, hooks/）出现宿主专属标识
 *   B 适配层（src/adapters）出现别的宿主
 *   C 宿主缝（src/dsh）直接引用 ZCode 母版实现
 *
 * 用法：node packages/core/tools/layering-audit.mjs [--json] [--strict]
 *   --strict：发现问题即 exit 1（供 CI 用）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..')
const ROOT = join(CORE, 'src')
const argv = process.argv.slice(2)

// 宿主专属标识：出现在母版里就是泄漏
const HOST_MARKS = {
  dsh: /\b(?:dsh-native|ctx\.tools|agent\.session|tools\/pre-execute|session\/event|FG_PTC_\w+|FG_MUTATION_UNMAPPED|focus-guard-native)\b/,
  zcode: /\b(?:ZCODE_\w+|CLAUDE_\w+|installed_plugins\.json|hookSpecificOutput)\b/,
}
// 宿主工具名（母版不该知道）。允许在"语义映射/注释"里出现的白名单文件。
const TOOL_NAMES = /\b(?:Bash|Write|Edit|MultiEdit|Read|Grep|Glob|pwsh|powershell|run_code)\b/
const ALLOW = {
  toolNames: ['core/risk.mjs', 'core/relation.mjs'], // risk 分类器目前按宿主名分派（已知债，见报告）
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (e.endsWith('.mjs') || e.endsWith('.js')) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const findings = []

for (const f of files) {
  const rel = relative(CORE, f).replace(/\\/g, '/')
  const src = readFileSync(f, 'utf8')
  const lines = src.split('\n')
  const inCore = rel.startsWith('src/core/')
  const inHooks = rel.startsWith('hooks/')
  const inAdapter = rel.startsWith('src/adapters/')
  const inDsh = rel.startsWith('src/dsh/')

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    // A：母版出现宿主标识
    if (inCore || inHooks) {
      for (const [host, re] of Object.entries(HOST_MARKS)) {
        if (re.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
          findings.push({ kind: `A 母版出现 ${host} 专属标识`, at, text: line.trim().slice(0, 100) })
        }
      }
      if (TOOL_NAMES.test(line) && !ALLOW.toolNames.includes(rel) && !/^\s*(\*|\/\/)/.test(line)) {
        findings.push({ kind: 'A 母版出现宿主工具名', at, text: line.trim().slice(0, 100) })
      }
    }
    // B：适配层写死**别的**宿主（`src/adapters/dsh/` 出现 dsh 标识是本职，不算泄漏）
    if (inAdapter) {
      const own = (rel.match(/src\/adapters\/([^/]+)\//) || [])[1] || ''
      for (const [host, re] of Object.entries(HOST_MARKS)) {
        if (own === host) continue
        if (re.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
          findings.push({ kind: `B ${own || '?'} 适配层出现 ${host} 标识`, at, text: line.trim().slice(0, 100) })
        }
      }
    }
    // C：宿主缝直接 import ZCode 母版实现
    if (inDsh && /from\s+['"][^'"]*hooks\/[^'"]*['"]/.test(line)) {
      findings.push({ kind: 'C 宿主缝直接引用 ZCode 母版代码', at, text: line.trim().slice(0, 100) })
    }
  })
}

const byKind = findings.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] || 0) + 1), acc), {})

if (argv.includes('--json')) {
  console.log(JSON.stringify({ total: findings.length, byKind, findings }, null, 2))
} else {
  console.log(`扫描 ${files.length} 个文件，发现 ${findings.length} 处分层泄漏`)
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`)
  for (const f of findings.slice(0, 40)) console.log(`  ${f.at}\n    [${f.kind}] ${f.text}`)
  if (findings.length > 40) console.log(`  …（共 ${findings.length} 条，--json 看全部）`)
}

if (argv.includes('--strict') && findings.length > 0) process.exit(1)
process.exit(0)
