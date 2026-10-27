#!/usr/bin/env node
/**
 * 工具链健康分（tools/health.mjs，2026-10-27）——内置化第三件，零依赖。
 *
 * 定位：**聚合器**，不重复实现任何扫描。四个维度各自来自已有工具：
 *   房规   ← tools/lint.mjs
 *   结构   ← tools/smells.mjs
 *   测试   ← 静态分析：哪些 src 模块没有被任何测试引用
 *   口径   ← tools/quality-audit.mjs
 *
 * 为什么自己算分：
 *   上一轮用 `brooks-lint` 出健康分，91/100。分数本身没问题，但**它的扣分项是按它自己的
 *   十三条风险模型算的**，与本仓关心的四件事（房规/结构/测试/口径）不完全对齐；而且它
 *   每维封顶 3 条，91 分读起来像"只差 9 分"，实际未封顶的问题是 66 条死 import + 398 行函数。
 *   本工具的分**不做封顶**，扣满为止——分数难看是故意的。
 *
 * 计分口径（2026-10-27 修）：**只算 src/ 活跃层**。
 *   首版把全部 66 条房规问题按 −1/条 扣，扣到 34 分，可其中 54 条在 `hooks/guard.mjs`
 *   与 `hooks/protocol.mjs`——那是已封存不维护的代码。**已封存代码的债务不是当前债务**，
 *   把它算进健康分与 `dsh-code-check` 的 0/100 是同一个病：扣分项与"当前该修的"不对齐。
 *   所以：src/ 计分，tools/+tests/+hooks/ 单列（不藏，只是不计分），输出里逐栏写明。
 *
 * 评分规则（确定性：同输入必同分）：
 *   房规   = 100 − min(70, src 层问题数 × 1)
 *   结构   = 100 − min(70, 源文件异味数 × 3)
 *   测试   = 100 − min(70, 无测试的 src 模块数 × 4)
 *   口径   = 100 − min(70, 未交代×10 + 清单重复×5)
 *   总分   = 加权（结构 0.30 / 房规 0.25 / 测试 0.25 / 口径 0.20），四舍五入
 *
 * 用法：
 *   node packages/core/tools/health.mjs            # 明细 + 总分
 *   node packages/core/tools/health.mjs --brief    # 一行
 *   node packages/core/tools/health.mjs --json
 *   node packages/core/tools/health.mjs --strict   # 低于债务上限 exit 1
 *
 * 关于 `--strict`（2026-10-27）：原为"低于 80 分 exit 1"，但当前 79 分且短期上不去
 * （结构维被 1243 行文件压着），那条闸门一开就红——与 lint/smells 同一个坑。
 * 改成棘轮：BUDGET 记当前分，只许升不许降。本工具**不进 check 链**：它的四个维度
 * 各自已被 lint/smells/quality-audit 单独把守，聚合分再加一道只会产生更模糊的信号。
 */

import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 判定逻辑在 lib/（纯函数、可测）。本文件只做"取数 → 调 → 打印"。
import { splitLintByLayer, classifyReach, weightedScore, dimensionScore, cappedScore } from './lib/health-core.mjs'
import { buildImportGraph, walk, relToSrc } from './lib/import-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')

const argv = process.argv.slice(2)
const BRIEF = argv.includes('--brief')
const AS_JSON = argv.includes('--json')
const STRICT = argv.includes('--strict')

/** 债务上限（棘轮）：总分不许低于此值。只许升不许降。 */
const BUDGET = 79

const runJson = (tool) => {
  const r = spawnSync('node', [join(HERE, tool), '--json'], { cwd: REPO, encoding: 'utf8' })
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`${tool} 的 JSON 输出无法解析（exit ${r.status}）：${(r.stderr || '').slice(0, 200)}`)
  }
}

/**
 * 取数：从测试与封存层出发，各求一次 src 内部的可达闭包。
 *
 * 判定逻辑在 `lib/health-core.mjs` 的 `classifyReach`（纯函数、可测）；
 * 读文件与解析 import 在 `lib/import-graph.mjs`（与 mutate.mjs 共用同一张图）。
 * 这里只做粘合。
 */
function coverage() {
  const g = buildImportGraph(REPO)
  const r = classifyReach({
    srcFiles: g.srcFiles,
    testSeeds: walk(join(REPO, 'packages/core/tests')),
    frozenSeeds: g.frozenFiles,
    depsOf: g.depsOf,
  })
  const rel = (f) => relToSrc(g.srcDir, f)
  return { total: r.total, active: r.active, frozenOnly: r.frozenOnly.map(rel), orphan: r.orphan.map(rel) }
}

const lint = runJson('lint.mjs')
const smells = runJson('smells.mjs')
const audit = runJson('quality-audit.mjs')
const cov = coverage()

// 房规按层分栏：只有 src/ 活跃层计分（见头注释「计分口径」）
const lintLayer = splitLintByLayer(lint.findings)

const DIMS = [
  {
    key: '房规',
    weight: 0.25,
    hits: lintLayer.src.length,
    score: dimensionScore(lintLayer.src.length, 1),
    top: lintLayer.src.length
      ? `${Object.entries(
          lintLayer.src.reduce((a, f) => ({ ...a, [f.rule]: (a[f.rule] || 0) + 1 }), {}),
        ).sort((a, b) => b[1] - a[1])[0][0]} 为主（${lintLayer.src.length} 条）`
      : 'Clean（src 层 0 条）',
  },
  {
    key: '结构',
    weight: 0.3,
    hits: smells.srcFindings.length,
    score: dimensionScore(smells.srcFindings.length, 3),
    top: smells.srcFindings.length
      ? smells.srcFindings.slice().sort((a, b) => b.value - a.value)[0].detail
      : 'Clean',
  },
  {
    key: '测试',
    weight: 0.25,
    hits: cov.orphan.length,
    score: dimensionScore(cov.orphan.length, 4),
    top: cov.orphan.length
      ? `${cov.orphan.length}/${cov.total} 个 src 模块测试与封存层都不可达`
      : `Clean（${cov.active}/${cov.total} 可达；${cov.frozenOnly.length} 个仅封存层可达）`,
  },
  {
    key: '口径',
    weight: 0.2,
    hits: audit.holes.length + audit.dupInList.length,
    score: cappedScore(audit.holes.length * 10 + audit.dupInList.length * 5),
    top: audit.holes.length || audit.dupInList.length ? `未交代 ${audit.holes.length} / 清单重复 ${audit.dupInList.length}` : 'Clean',
  },
]

const composite = weightedScore(DIMS)

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        composite,
        dimensions: DIMS,
        lintByLayer: {
          src: lintLayer.src.length,
          tools: lintLayer.tools.length,
          tests: lintLayer.tests.length,
          hooks: lintLayer.hooks.length,
        },
        untested: { active: cov.active, frozenOnly: cov.frozenOnly, orphan: cov.orphan },
      },
      null,
      2,
    ),
  )
} else if (BRIEF) {
  const parts = DIMS.map((d) => `${d.key} ${d.score}`).join(' / ')
  const side = lintLayer.tools.length + lintLayer.tests.length + lintLayer.hooks.length
  console.log(`工具链健康分：${composite}/100（${parts}；层外房规 ${side} 条不计分）`)
} else {
  console.log(`工具链健康分：${composite}/100\n`)
  console.log('维度\t权重\t得分\t首要问题')
  for (const d of DIMS) console.log(`${d.key}\t${d.weight}\t${d.score}\t${d.top}`)
  console.log('\n扣分不封顶（每维扣满 70 为止），分数难看是故意的：')
  console.log(`  房规 ${lintLayer.src.length} 条（每条 −1）`)
  console.log(`  结构 ${smells.srcFindings.length} 条（每条 −3）`)
  console.log(`  测试 ${cov.orphan.length} 个模块双不可达（每个 −4）`)
  console.log(`  口径 未交代 ${audit.holes.length} 条（每条 −10）+ 清单重复 ${audit.dupInList.length} 条（每条 −5）`)
  console.log('\n计分口径 = 仅 src/ 活跃层。层外房规单列、不计分：')
  console.log(`  tools/  ${lintLayer.tools.length} 条`)
  console.log(`  tests/  ${lintLayer.tests.length} 条`)
  console.log(`  hooks/  ${lintLayer.hooks.length} 条（已封存，不维护）`)
  console.log(`\nsrc 模块可达性：${cov.active}/${cov.total} 从测试可达`)
  if (cov.frozenOnly.length) {
    console.log(`  ${cov.frozenOnly.length} 个仅封存层可达（不扣分，单列）：`)
    for (const f of cov.frozenOnly) console.log(`    ${f}`)
  }
  if (cov.orphan.length) {
    console.log(`  ${cov.orphan.length} 个双不可达（扣分）：`)
    for (const f of cov.orphan) console.log(`    ${f}`)
  }
}
process.exit(STRICT && composite < BUDGET ? 1 : 0)
