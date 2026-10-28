/**
 * 文档口径检查（3.3 D5）：版本面 + 相对链接。零依赖。
 *
 * 用法：
 *   node packages/core/tools/docs-lint.mjs            # 明细
 *   node packages/core/tools/docs-lint.mjs --brief    # 一行（供 npm run check）
 *   node packages/core/tools/docs-lint.mjs --json     # 机器读
 *   node packages/core/tools/docs-lint.mjs --strict   # 有问题即 exit 1
 *
 * 闸门是棘轮：`BUDGET` 记当前存量（初始 0），只许降不许升。
 * 这是 3.5「文档重置完成」的前置尺子（D5）；README 硬指标、数字单点、状态头分别归 D1/D4/D2。
 */
import { fileURLToPath } from 'node:url'
import { listMarkdownFiles, checkVersionFace, checkRelativeLinks } from './lib/docs-core.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const BRIEF = argv.includes('--brief')
const STRICT = argv.includes('--strict')
const BUDGET = 0

const files = listMarkdownFiles(ROOT)
const findings = [...checkVersionFace(ROOT), ...checkRelativeLinks(ROOT, files)]
const byRule = {}
for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1

if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, findings, byRule, budget: BUDGET }, null, 2))
} else if (BRIEF) {
  const parts = Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${n}`)
  const gate = findings.length > BUDGET ? `❌ 超上限 ${BUDGET}` : `✅ 上限 ${BUDGET}`
  console.log(`文档口径：${files.length} 个 md，问题 ${findings.length} 条${parts.length ? `（${parts.join(' / ')}）` : ''}；${gate}`)
} else {
  console.log(`文档口径：${files.length} 个 md，问题 ${findings.length} 条\n`)
  if (!findings.length) console.log('无问题（版本面一致 / 相对链接全部可达）。')
  for (const f of findings) console.log(`${f.file}:${f.line}\t[${f.rule}] ${f.detail}`)
  console.log(`\n闸门口径：${findings.length} 条 / 上限 ${BUDGET}（棘轮，只许降不许升）。`)
}
process.exit(STRICT && findings.length > BUDGET ? 1 : 0)
