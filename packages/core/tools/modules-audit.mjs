#!/usr/bin/env node
/**
 * 模块修订审计（tools/modules-audit.mjs，2026-11-19）
 *
 * 回答一个问题：**哪块地方很久没人看了？**
 *
 * 数据全部现算自 git，清单在 `lib/modules-list.mjs`，算法在 `lib/modules.mjs`。
 * 为什么判据用「其后全仓提交」、为什么看中位文件而不是最新文件——见那两个文件的文件头。
 *
 * 用法：
 *   node packages/core/tools/modules-audit.mjs            # 一行摘要（供 check 链）
 *   node packages/core/tools/modules-audit.mjs --table    # 完整表
 *   node packages/core/tools/modules-audit.mjs --json     # 机器读
 *   node packages/core/tools/modules-audit.mjs --sync     # 写 docs/MODULES.md
 *   node packages/core/tools/modules-audit.mjs --check-doc  # 台账是否落后
 *   node packages/core/tools/modules-audit.mjs --strict   # 清单有缺陷时 exit 1
 *
 * 退出码：默认只在 `--strict` 下因清单缺陷（路径缺失/重叠/未归属/id 重复）非零；
 * 「久未动」本身**永不**导致非零——那是信息，不是错误。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODULES,
  MODULES_DOC,
  collectModules,
  collectCoverage,
  renderModules,
  checkModulePaths,
  checkModuleIds,
  checkModuleOverlap,
  checkModuleCoverage,
  checkModulesDoc,
} from './lib/modules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)

const data = collectModules(ROOT, MODULES)
const coverage = collectCoverage(ROOT, MODULES)
const problems = [
  ...checkModulePaths(ROOT, MODULES),
  ...checkModuleIds(MODULES),
  ...checkModuleOverlap(ROOT, MODULES),
  ...checkModuleCoverage(ROOT, MODULES),
]

if (has('--sync')) {
  writeFileSync(join(ROOT, MODULES_DOC), renderModules(data, coverage))
  process.stdout.write(`[modules] 已生成 ${MODULES_DOC}：${data.rows.length} 个模块\n`)
  process.exit(0)
}

if (has('--json')) {
  process.stdout.write(`${JSON.stringify({ head: data.head, age: data.age, total: data.total, rows: data.rows, coverage, problems }, null, 2)}\n`)
  process.exit(has('--strict') && problems.length ? 1 : 0)
}

const byLevel = (lv) => data.rows.filter((r) => r.level === lv)
const dirty = data.rows.filter((r) => r.dirty)

if (has('--check-doc')) {
  const docFindings = checkModulesDoc(ROOT)
  process.stdout.write(docFindings.length ? `[modules] ${docFindings[0].detail}\n` : '[modules] 台账与现算一致\n')
  process.exit(docFindings.length ? 1 : 0)
}

if (has('--table')) {
  process.stdout.write(`模块修订（HEAD ${data.head ? data.head.slice(0, 7) : '—'} · 仓龄 ${data.age} 天 · ${data.total} 次提交）\n\n`)
  process.stdout.write('  距今：最新 = 最勤快的文件；中位 = 一半文件比它旧（判定看它）；最久 = 最沉的文件\n\n')
  const icon = { 久未动: '✗', 临期: '!', 偏冷: '·', 活跃: '·', 无法定位: '?' }
  for (const r of data.rows) {
    const flags = []
    if (r.touches < 3) flags.push('历史浅')
    if (r.dirty) flags.push('有未提交改动')
    const tail = flags.length ? ` · ${flags.join(' · ')}` : ''
    const span = `${r.latestDays}/${r.medianDays}/${r.oldestDays}`.padStart(11)
    process.stdout.write(
      `  ${icon[r.level]} ${r.name.padEnd(20, '　')} 距今 ${span} 天 · 中位其后 ${String(r.median ?? '—').padStart(3)} 次 · ${String(r.files).padStart(2)} 文件 · ${r.level}${tail}\n`,
    )
  }
  process.stdout.write(
    '\n图例：✗ 久未动　! 临期　· 偏冷/活跃　? 无法定位\n' +
      '判定看「中位文件其后全仓提交数」：该文件最后修订之后，仓库又走了多少步。≥30 偏冷 / ≥80 临期 / ≥150 久未动。\n' +
      `覆盖：受管 ${coverage.total} 个文件，仓根元数据 ${coverage.meta} 个，未归属功能文件 ${coverage.unowned} 个\n`,
  )
} else {
  // 摘要行：进 check 链，每次跑都提一句。**不红**——久未动不等于坏。
  // 不逐条列 id：三十几个模块列出来没人读，只报计数与前三个最陈旧的。
  const n = (lv) => byLevel(lv).length
  const worst = data.rows
    .filter((r) => r.level === '久未动')
    .slice(0, 3)
    .map((r) => `${r.id} ${r.median} 次`)
  const rest = []
  if (n('无法定位')) rest.push(`无法定位 ${n('无法定位')}`)
  if (dirty.length) rest.push(`有未提交改动 ${dirty.length}`)
  process.stdout.write(
    `模块修订：${data.rows.length} 个模块，久未动 ${n('久未动')} / 临期 ${n('临期')} / 偏冷 ${n('偏冷')} / 活跃 ${n('活跃')}` +
      `${worst.length ? `；最陈旧 ${worst.join(' · ')}` : ''}${rest.length ? `；${rest.join('；')}` : ''}\n`,
  )
}

for (const p of problems) process.stdout.write(`  ✗ [${p.rule}] ${p.detail}\n`)
process.exit(has('--strict') && problems.length ? 1 : 0)
