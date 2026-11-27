#!/usr/bin/env node
/**
 * 抽样变异测试（tools/mutate.mjs，2026-10-27）——内置化第四件，零依赖。
 *
 * 为什么自己写：
 *   `quality:mutate` 走 `npx --yes --package @stryker-mutator/...`，是"零依赖"剩下的最后一环。
 *   但直接自研完整变异引擎是不划算的：历史上手写版 9 个变异体跑了 5 分钟，Stryker 单文件
 *   6 秒跑 51 个变异体，**手写版完败**。败因不是变异算法，是**测试选择**——手写版每个
 *   变异体都跑全量测试，Stryker 用覆盖率只跑相关的。
 *
 * 所以本工具的设计只有一条核心：**用 import 图选测试**。
 *   `lib/import-graph.mjs` 已经能算出"哪些测试文件触达某个 src 模块"（health.mjs 也在用），
 *   变异一个模块时只跑那几个文件，而不是全量 498 条。
 *
 * 与 Stryker 的差距（**必须看清，别当等价物**）：
 *   ① 变异算子只有 6 类（见 OPERATORS）。**不做**语句删除、返回值替换、
 *      数字/字符串字面量替换、数组/对象字面量替换——那些需要 AST。
 *   ② 测试选择粒度是**文件**，不是语句级覆盖率。一个模块若被慢文件触达（如
 *      `acceptance.test.mjs` 单文件 29s），本工具会明显变慢，故设 `--max` 与慢文件告警。
 *   ③ 结果可复现（同输入同变异体同顺序），但不追求与 Stryker 分数可比。
 *   ④ **存活里混着等价变异体**（改了行为不变）。工具不区分，得人工判读。
 *   结论：**它是"有没有断言"的抽样探针，不是"变异覆盖率"的完整度量。**
 *   要完整度量仍用 `npm run quality:mutate`（Stryker，需联网拉包）。
 *
 * 分数可信度的两道闸（都是被假数字逼出来的）：
 *   · 变异**前**跑两次基线：只要一次红就拒绝变异（偶发失败会被算成"杀死"）。
 *   · 变异**后**再跑一次基线：红了就把结果标 `不可信`，不把假分数报出去。
 *   实测见过首次跑 `toolName` 报 2/2 全杀、复跑 0/2 全存活——前一次的"杀死"来自
 *   某次测试的残留状态偶发失败。**没有事后复验，这种假数字会直接进报告。**
 *
 * 安全设计（重点）：
 *   **真实源码永不被改动。** 先把 `packages/` 复制到临时目录，所有变异在副本里做，
 *   跑完删副本。首版考虑过"原地变异 + finally 还原"，被否——进程被强杀就留下脏源码，
 *   而这个仓的源码是安全闸门本体，脏了比跑不完严重得多。
 *
 * 用法：
 *   node packages/core/tools/mutate.mjs dsh/toolName.mjs            # 变异一个模块
 *   node packages/core/tools/mutate.mjs core/approval.mjs --list    # 只列变异体，不跑
 *   node packages/core/tools/mutate.mjs dsh/postProgress.mjs --max 30
 *   node packages/core/tools/mutate.mjs dsh/postProgress.mjs --json
 *
 * 退出码：默认恒 0（只报不改）；`--strict` 时存活率超 `--max-survive`（默认 40%）才 exit 1。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve, basename, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildImportGraph } from './lib/import-graph.mjs'
import { generateMutants, applyMutant } from './lib/mutation-ops.mjs'
import { copyRepo } from './lib/repo-copy.mjs'
import { surveyParallel, reportSurvey } from './lib/survey-report.mjs'
// 副本与抽样汇总搬去 lib/，仍从这里再导出：测试与外部只认 tools/mutate.mjs 这个入口。
export { copyRepo }

const HERE = dirname(fileURLToPath(import.meta.url))
// 仓库根可覆盖：端到端测试要跑**受控夹具**，不能跑在真实仓库的测试上——
// 真实测试有偶发失败，会让"变异得分"时高时低，测试跟着抖。
// 与 lint/smells 同一思路：**测试必须能把被测对象指到别处**。
const REPO = process.env.FG_REPO_ROOT ? resolve(process.env.FG_REPO_ROOT) : resolve(HERE, '../../..')

const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const LIST_ONLY = argv.includes('--list')
const STRICT = argv.includes('--strict')
/** 全模块抽样（3.5.4）。与单模块模式互斥：走 survey 时不看 targets。 */
const SURVEY = argv.includes('--survey')
const numArg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt
}
/**
 * 并行度与分片（2026-11-27）。
 *
 * 串行实测 **约 25 秒/模块**（78 个模块 ≈ 30 分钟）——卡在 `node --test` 的启动与
 * 慢文件（`acceptance.test.mjs` 单文件 29 秒），与变异算法无关。计划里的判据是
 * 「一条命令 ≤5 分钟」，串行永远达不到，所以必须并行。
 *
 * 分片而不是线程：每个分片是一个子进程，各建各的临时副本。模块之间只读共享源码、
 * 只写自己那一个文件，进程隔离后连「测试互相污染状态」都不用担心。
 */
const JOBS = numArg('--jobs', 4)
const SHARD = (() => {
  const i = argv.indexOf('--shard')
  if (i < 0) return null
  const [a, b] = String(argv[i + 1] || '').split('/').map(Number)
  return a >= 0 && b > 0 ? { index: a, of: b } : null
})()
// survey 默认每模块抽 3 个：不设上限就是「全量跑全模块」，一轮几小时，没人会跑第二次。
const MAX = numArg('--max', SURVEY ? 3 : Infinity)
const MAX_SURVIVE = numArg('--max-survive', 40)
// survey 的单次超时给到 180 秒：10 路并行时机器被占满，`core/` 那批含 acceptance 的
// 测试集平时 26 秒，负载下会顶到 60 秒以上。超时被算成「基线未通过」会把人指去查断言。
const PER_MUTANT_TIMEOUT = numArg('--timeout', SURVEY ? 180000 : 60000)

// 算子与生成/应用搬去 lib/mutation-ops.mjs（3.5.4）：纯函数，与编排无关。
// 仍从这里再导出——测试与外部只认 tools/mutate.mjs 这个入口。
export { generateMutants, applyMutant }

function runTests(cwd, testFiles) {
  const env = {
    ...process.env,
    // 隔离：子进程不许继承宿主的工作区根，否则变异跑出来的审计会写脏真实 AUDIT.log
    // （`npm run eval` 上踩过：单跑一次写脏 62 行）。**清空这三个就够了**——
    // 剩下没清空的路径都由 `process.cwd()` 推出来，而 cwd 是临时副本，写脏也只在副本里。
    ZCODE_PROJECT_DIR: '',
    CLAUDE_PROJECT_DIR: '',
    FG_PROJECT_DIR: '',
    FG_SHELL: '',
    // 2026-11-27（3.5.4）：**不要设 `FG_AUDIT_FILE`**。原先设成副本里的
    // `.focus-guard/mutate-audit.log`，本意是「别写真实流水」，实际把 26 条用例弄红了——
    // 那些用例断言的是默认审计路径上的内容，改了文件名就等于让它们断言一个空文件。
    // 实测：只设这一个变量 → 435 过 / 26 红；只清空三个 PROJECT_DIR → 461 全过。
  }
  // **必须删掉 NODE_TEST_CONTEXT（2026-10-27 实测）。**
  // 这个变量在 `node --test` 里会被设成 `child-v8`，子进程继承后 `node --test` 会**恒 exit 0**，
  // 哪怕测试明确失败。后果：从任何测试里调本工具，所有变异体都被判"存活"，得分是假的。
  // 这是端到端用例抓出来的——同一夹具在测试里跑出 2/2 存活、在终端里跑出 1 杀 1 活。
  // 判据：**跑测试的子进程，环境必须和终端一致**，否则测的不是被测对象。
  delete env.NODE_TEST_CONTEXT

  const r = spawnSync('node', ['--test', ...testFiles], {
    cwd,
    encoding: 'utf8',
    timeout: PER_MUTANT_TIMEOUT,
    env,
  })
  return { ok: r.status === 0, timedOut: r.error?.code === 'ETIMEDOUT', out: `${r.stdout || ''}${r.stderr || ''}` }
}

// ───────────────────────────── 主流程 ─────────────────────────────
//
// 整段由 `isMain` 守卫。原因：不这样做的话，测试文件一
// `import { generateMutants }` 就会执行 CLI 并 `exit(2)`，纯函数根本测不到。
// `health.mjs` 上踩过同一个坑（当时是把逻辑抽到 lib/ 解决的，这里逻辑本身就少，
// 加守卫就够）。判据：**凡是要被测试 import 的 CLI，必须有主模块判定。**
//
// 拆成 5 个小函数是**被自己的 smells 工具逼的**：首版一个 `main()` 148 行，
// 直接撞上阈值 80，把结构维从 28 条推到 29 条。棘轮的规矩是只许降不许升，
// 所以拆代码，不是调上限。

/** 解析目标模块，算变异计划。`g` 可复用：survey 一次建图跑全模块，不重复建。 */
function planTargets(targets, g = buildImportGraph(REPO)) {
  const plans = targets.map((t) => {
    const abs = resolve(g.srcDir, t)
    try {
      readFileSync(abs)
    } catch {
      console.error(`找不到模块：${t}（相对 packages/core/src）`)
      process.exit(2)
    }
    const src = readFileSync(abs, 'utf8')
    const all = generateMutants(src)
    // 抽样必须**等距**，不能取前 N 个（2026-11-27 实测）。
    // 取前 3 个拿到的是文件最开头那几个变异体——那里通常是 import 与常量表，
    // 改了对行为没影响（等价变异体）或压根没断言。结果：一批模块齐刷刷 0 分，
    // 与单模块全量跑出来的 50%~100% 完全对不上。等距至少覆盖文件首中尾。
    const selected =
      Number.isFinite(MAX) && all.length > MAX
        ? Array.from({ length: MAX }, (_, k) => all[Math.floor((k * all.length) / MAX)])
        : all
    // `rel` 与 `name` 都要：单模块模式看 `name` 够，survey 里两个 `index.mjs` 只能靠路径分开。
    return { abs, name: basename(abs), rel: t, src, all, mutants: selected, tests: g.reachingTests(abs) }
  })
  return { g, plans }
}

/** `--list`：只报计划，不复制、不跑测试。 */
function listPlans(plans) {
  for (const p of plans) {
    const byOp = {}
    for (const m of p.all) byOp[m.op] = (byOp[m.op] || 0) + 1
    console.log(`${p.name}：${p.all.length} 个变异体 ${JSON.stringify(byOp)}；触达测试 ${p.tests.length} 个`)
    for (const m of p.mutants.slice(0, 20)) {
      const before = p.src.split('\n')[m.line - 1].trim()
      console.log(`  L${m.line} [${m.op}] ${m.token} → ${m.replacement || '(删)'}    ${before.slice(0, 70)}`)
    }
    if (p.mutants.length > 20) console.log(`  …另有 ${p.mutants.length - 20} 个`)
  }
}

/**
 * 跑一个模块：基线校验 → 逐个变异 → 事后复验。
 * 返回 { ...统计, survivors?, skipped?, unreliable? }。
 */
function runModule(work, g, p) {
  const targetInCopy = join(work, 'packages/core/src', p.abs.slice(g.srcDir.length + 1))
  const testsInCopy = p.tests.map((t) => join(work, t.slice(REPO.length + 1)))
  const base = { name: p.name, rel: p.rel, total: p.mutants.length, generated: p.all.length, tests: p.tests.length }

  if (!p.mutants.length) return { ...base, skipped: '该模块没有可变异算子（纯常量表或纯声明）' }
  if (!p.tests.length) {
    return { ...base, skipped: '没有任何测试文件触达该模块，变异体全存活，测了也没意义' }
  }

  // 基线：不变异先跑一次。**基线本身是红的就不能变异**——否则"杀死"是假的。
  //
  // 重试一次是因为实测发现本仓有**状态相关的偶发失败**（`preGuard.test.mjs`
  // 的"异常一律不阻塞"偶发红，连跑 6 次又全绿）。重试只用来**判定基线是否可信**，
  // 不用来"重试到绿"——两次里只要有一次红就判基线不可信并跳过。
  const b1 = runTests(work, testsInCopy)
  const b2 = b1.ok ? b1 : runTests(work, testsInCopy)
  if (!b1.ok || !b2.ok) {
    const flaky = b1.ok !== b2.ok
    // 超时与「测试真的红了」必须分开报（2026-11-27）。并行抽样时机器被占满，
    // 一个平时 26 秒的测试集可能顶到 60 秒超时；报成「基线未通过」会让人去查断言，
    // 而实际要调的是 `--timeout`。**报错指错方向，比不报还费时间。**
    const why = b1.timedOut || b2.timedOut
      ? '基线超时（单次测试跑不完，多半是并行负载下超时，调大 --timeout）'
      : flaky
        ? '基线不稳定（一次红一次绿）'
        : '基线测试未通过'
    return {
      ...base,
      skipped: `${why}，拒绝变异。偶发失败会被算成"杀死"，变异得分不可信：${b2.out.slice(-300)}`,
    }
  }

  let killed = 0
  let timedOut = 0
  const survivors = []
  for (const m of p.mutants) {
    writeFileSync(targetInCopy, applyMutant(p.src, m))
    const r = runTests(work, testsInCopy)
    writeFileSync(targetInCopy, p.src) // 立刻还原，下一个变异体基于原码
    if (r.timedOut) {
      timedOut += 1
      killed += 1 // 超时按杀死算（测试没能通过）
    } else if (r.ok) {
      survivors.push({ line: m.line, op: m.op, token: m.token, replacement: m.replacement })
    } else {
      killed += 1
    }
  }
  const out = { ...base, killed, timedOut, survivors, score: Math.round((killed / p.mutants.length) * 1000) / 10 }

  // 事后校验（2026-10-27 补）：循环跑完、源码已还原，再跑一次基线。
  //
  // 为什么必须有这一步：实测见过"杀死数虚高"——循环中某次测试因**残留状态**偶发失败，
  // 被算成"这个变异体被杀了"，而实际上它压根没被杀。首次跑 toolName 得到 2/2 全杀，
  // 复跑变成 0/2 全存活，就是这种情况。基线只在循环前检查**抓不住循环中的污染**。
  writeFileSync(targetInCopy, p.src)
  if (!runTests(work, testsInCopy).ok) {
    out.unreliable = '变异循环结束后基线变红（测试有状态泄漏或偶发失败），杀死数可能虚高，本次结果不可信'
  }
  return out
}

/** 输出与退出码。 */
function report(results) {
  const alive = results.reduce((s, r) => s + (r.survivors ? r.survivors.length : 0), 0)
  const ran = results.reduce((s, r) => s + (r.killed || 0) + (r.survivors ? r.survivors.length : 0), 0)

  if (AS_JSON) {
    console.log(JSON.stringify({ results, alive, ran }, null, 2))
  } else {
    for (const r of results) {
      console.log(`\n${r.name}：生成 ${r.generated} 个变异体，本次跑 ${r.total} 个，触达测试 ${r.tests} 个`)
      if (r.skipped) {
        console.log(`  跳过：${r.skipped}`)
        continue
      }
      console.log(`  杀死 ${r.killed}（其中超时 ${r.timedOut}）/ 存活 ${r.survivors.length}　变异得分 ${r.score}%`)
      if (r.unreliable) console.log(`  ⚠ ${r.unreliable}`)
      for (const s of r.survivors) console.log(`    存活 L${s.line} [${s.op}] ${s.token} → ${s.replacement || '(删)'}`)
    }
    console.log('\n读法（重要）：存活分两种——「真缺口」（该分支没断言）与「等价变异体」（改了行为不变）。')
    console.log('本工具不区分这两者，得人工判读。所以得分**不可与 Stryker 的覆盖率分数直接比**。')
    console.log('算子只有 6 类（无语句删除/返回值替换/字面量替换），测试选择粒度是文件不是覆盖率。')
  }
  return STRICT && ran > 0 && (alive / ran) * 100 > MAX_SURVIVE ? 1 : 0
}



/**
 * `--survey`：全模块抽样出分（2026-11-27，3.5.4）。
 *
 * 为什么要它：单模块模式回答「这个模块的断言密不密」，但排期需要的是
 * 「**75 个模块里哪些最薄**」——没有全表，就只能凭印象挑，挑完再跑一轮，一轮几十分钟。
 *
 * 抽样而不是全量：`--max` 默认 3。全量跑全模块是一轮几小时的事，没人会跑第二次，
 * 而**没人会跑第二次的尺子等于没有**。3 个变异体足以区分「有断言」与「没断言」，
 * 分不出 92% 与 95%——那也不需要在这里分。
 *
 * 基线红的模块会自己标「跳过」并说明原因，不混进平均分：把「测不了」算成「0 分」
 * 会让平均分变成「副本能不能跑」的函数，而不是「断言密不密」的函数。
 */
function runSurvey() {
  const g = buildImportGraph(REPO)
  let targets = g.srcFiles.map((f) => relative(g.srcDir, f).split(sep).join('/'))
  // 分片按取模切：源码顺序稳定，同输入同分片，结果可复现。
  if (SHARD) targets = targets.filter((_, k) => k % SHARD.of === SHARD.index)
  const { plans } = planTargets(targets, g)
  const work = mkdtempSync(join(tmpdir(), 'fg-mutate-'))
  copyRepo(REPO, work)
  const rows = []
  try {
    for (const [i, p] of plans.entries()) {
      // 模块之间必须清运行时状态（2026-11-27 实测）。
      // 串行跑同一副本时，前一个模块的测试会把 `.focus-guard/` 写脏；后一个模块的基线
      // 读到脏状态就红，于是被标成「基线测试未通过」。实测 `core/risk.mjs` 单跑 100%，
      // 在 survey 里却报基线红——**同一份源码两种结论，只能是状态污染**。
      rmSync(join(work, '.focus-guard'), { recursive: true, force: true })
      process.stderr.write(`[${i + 1}/${plans.length}] ${p.rel} … `)
      const r = runModule(work, g, p)
      rows.push(r)
      process.stderr.write(r.skipped ? '跳过\n' : `${r.score}%\n`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (SHARD) {
    // 子进程只交数据，排版交给父进程——两边各排一份必然分叉。
    console.log(`__ROWS__${JSON.stringify(rows)}`)
    return 0
  }
  reportSurvey(rows)
  return 0
}



function main() {
  if (SURVEY) {
    // 分片进程与单进程都走 runSurvey；只有「父进程 + jobs>1」才并行派发。
    if (SHARD || JOBS <= 1) process.exit(runSurvey())
    surveyParallel({ jobs: JOBS, self: fileURLToPath(import.meta.url), repo: REPO }).then(() => process.exit(0))
    return
  }
  const targets = argv.filter(
    (a, i) => !a.startsWith('--') && !/^\d+$/.test(a) && !['--max', '--max-survive', '--timeout'].includes(argv[i - 1]),
  )
  if (!targets.length) {
    console.error('用法：node packages/core/tools/mutate.mjs <src 相对路径...> [--list] [--max n] [--json] [--strict]')
    console.error('      node packages/core/tools/mutate.mjs --survey [--max n]    # 全模块抽样出分')
    console.error('  例：node packages/core/tools/mutate.mjs dsh/toolName.mjs')
    process.exit(2)
  }

  const { g, plans } = planTargets(targets)
  if (LIST_ONLY) {
    listPlans(plans)
    process.exit(0)
  }

  // 复制到临时目录：真实源码永不被改
  const work = mkdtempSync(join(tmpdir(), 'fg-mutate-'))
  copyRepo(REPO, work)

  const results = []
  try {
    for (const p of plans) results.push(runModule(work, g, p))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  process.exit(report(results))
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
