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
import {
  listMarkdownFiles,
  checkVersionFace,
  checkRelativeLinks,
  checkCodePathRefs,
  checkStatusHeaders,
  checkIndexCoverage,
  allDocFiles,
  checkReadmeMetrics,
  checkCitationStyle,
} from './lib/docs-core.mjs'
import { checkVersionClaims } from './lib/docs-version.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const BRIEF = argv.includes('--brief')
const STRICT = argv.includes('--strict')
const BUDGET = 0

/**
 * 按规则的存量豁免（3.3 A）。
 *
 * 原为 `{ 'dead-code-path': 5 }`——那 5 条全在 CHANGELOG 的历史段里，指向当年存在、后来搬走的文件。
 * 2026-11-07 历史段（≤3.0.7）原样移入 `docs/archive/`（不在扫描面内），存量归零，额度一并收回。
 * 判据：豁免是**存量**的记账。存量没了还留着额度，等于给未来的死链预留藏身处。
 */
const RULE_BUDGET = { 'dead-code-path': 0 }

const files = listMarkdownFiles(ROOT)
const findings = [
  ...checkVersionFace(ROOT),
  ...checkRelativeLinks(ROOT, files),
  ...checkCodePathRefs(ROOT, files),
  ...checkStatusHeaders(ROOT),
  ...checkIndexCoverage(ROOT, allDocFiles(ROOT)),
  ...checkReadmeMetrics(ROOT),
  ...checkCitationStyle(ROOT),
  ...checkVersionClaims(ROOT),
]
const byRule = {}
for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1
// 超限数按规则算：某规则在自己的豁免内不算超限，别让历史存量压住新问题
const over = Object.entries(byRule).reduce(
  (sum, [rule, n]) => sum + Math.max(0, n - (RULE_BUDGET[rule] || 0)),
  0,
)

if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, findings, byRule, budget: BUDGET, ruleBudget: RULE_BUDGET, over }, null, 2))
} else if (BRIEF) {
  const parts = Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${n}${RULE_BUDGET[r] ? `(豁免${RULE_BUDGET[r]})` : ''}`)
  const gate = over > BUDGET ? `❌ 超上限 ${BUDGET}` : `✅ 上限 ${BUDGET}`
  console.log(`文档口径：${files.length} 个 md，问题 ${findings.length} 条${parts.length ? `（${parts.join(' / ')}）` : ''}；${gate}`)
} else {
  console.log(`文档口径：${files.length} 个 md，问题 ${findings.length} 条\n`)
  if (!findings.length) console.log('无问题（版本面一致 / 相对链接全部可达 / 行内路径全部可达）。')
  for (const f of findings) {
    const allow = RULE_BUDGET[f.rule] ? '（存量豁免）' : ''
    console.log(`${f.file}:${f.line}\t[${f.rule}]${allow} ${f.detail}`)
  }
  console.log(`\n闸门口径：超限 ${over} 条 / 上限 ${BUDGET}（棘轮，只许降不许升）。`)
  for (const [rule, n] of Object.entries(RULE_BUDGET)) {
    console.log(`  豁免：${rule} 最多 ${n} 条（当前 ${byRule[rule] || 0} 条）`)
  }
}
process.exit(STRICT && over > BUDGET ? 1 : 0)
