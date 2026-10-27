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
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { stripLiterals } from './lib/source-text.mjs'
import { buildImportGraph } from './lib/import-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 仓库根可覆盖：端到端测试要跑**受控夹具**，不能跑在真实仓库的测试上——
// 真实测试有偶发失败，会让"变异得分"时高时低，测试跟着抖。
// 与 lint/smells 同一思路：**测试必须能把被测对象指到别处**。
const REPO = process.env.FG_REPO_ROOT ? resolve(process.env.FG_REPO_ROOT) : resolve(HERE, '../../..')

const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const LIST_ONLY = argv.includes('--list')
const STRICT = argv.includes('--strict')
const numArg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt
}
const MAX = numArg('--max', Infinity)
const MAX_SURVIVE = numArg('--max-survive', 40)
const PER_MUTANT_TIMEOUT = numArg('--timeout', 60000)

/**
 * 变异算子。每个算子：正则 + 替换规则。
 *
 * 全部作用在 `stripLiterals` 之后的文本上——否则 `'== 分布 =='` 这种字符串里的运算符
 * 会被当成代码变异，跑出来的"存活"全是假的。去字面量保留长度与换行，
 * 所以 `plain` 里的下标可以直接映射回原文件（下面有长度断言兜底）。
 */
const OPERATORS = [
  { id: 'comparison', re: /(?<![<>=!])(<=|>=|<|>)(?![=<>])/g, flip: { '<': '<=', '<=': '<', '>': '>=', '>=': '>' } },
  { id: 'equality', re: /(?<![=!<>])(===|!==)(?!=)/g, flip: { '===': '!==', '!==': '===' } },
  { id: 'boolean', re: /(?<![\w$.])(&&|\|\|)(?![\w$])/g, flip: { '&&': '||', '||': '&&' } },
  { id: 'literal-bool', re: /(?<![\w$.])(true|false)(?![\w$])/g, flip: { true: 'false', false: 'true' } },
  { id: 'nullish', re: /(?<![\w$.])\?\?(?![\w$])/g, flip: { '??': '||' } },
  // 去掉一个 `!`：`if (!reason)` → `if (reason)`。闸门类代码里这条最能暴露"没人断言"。
  // 捕获组不能省：`m[1]` 取的是 token，没有捕获组时是 undefined，整条算子会**静默失效**
  // （这个 bug 是 `mutate.test.mjs` 抓出来的——自己写的算子也会犯"看起来跑了"的错）。
  { id: 'negation', re: /(?<![!=<>])(!)(?!=)/g, flip: { '!': '' } },
]

/** 生成变异体：{ op, index, token, replacement, line } */
export function generateMutants(src) {
  const plain = stripLiterals(src)
  if (plain.length !== src.length) {
    throw new Error(`stripLiterals 改变了长度（${src.length} → ${plain.length}），下标无法映射，拒绝变异`)
  }
  const lineStarts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1)
  const lineOf = (idx) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const out = []
  for (const op of OPERATORS) {
    for (const m of plain.matchAll(op.re)) {
      const token = m[1]
      const replacement = op.flip[token]
      if (replacement === undefined) continue
      out.push({ op: op.id, index: m.index, token, replacement, line: lineOf(m.index) })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/** 把第 i 个变异体应用到源码上，返回新源码。 */
export function applyMutant(src, mutant) {
  return src.slice(0, mutant.index) + mutant.replacement + src.slice(mutant.index + mutant.token.length)
}

function runTests(cwd, testFiles) {
  const env = {
    ...process.env,
    // 隔离：子进程不许继承宿主的工作区根，否则变异跑出来的审计会写脏真实 AUDIT.log
    // （`npm run eval` 上踩过：单跑一次写脏 62 行）。
    ZCODE_PROJECT_DIR: '',
    CLAUDE_PROJECT_DIR: '',
    FG_PROJECT_DIR: '',
    FG_SHELL: '',
    FG_AUDIT_FILE: join(cwd, '.focus-guard', 'mutate-audit.log'),
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

/** 解析目标模块，算变异计划。 */
function planTargets(targets) {
  const g = buildImportGraph(REPO)
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
    const selected = Number.isFinite(MAX) ? all.slice(0, MAX) : all
    return { abs, name: basename(abs), src, all, mutants: selected, tests: g.reachingTests(abs) }
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
  const base = { name: p.name, total: p.mutants.length, generated: p.all.length, tests: p.tests.length }

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
    return {
      ...base,
      skipped: `${flaky ? '基线不稳定（一次红一次绿）' : '基线测试未通过'}，拒绝变异。偶发失败会被算成"杀死"，变异得分不可信：${b2.out.slice(-300)}`,
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

function main() {
  const targets = argv.filter(
    (a, i) => !a.startsWith('--') && !/^\d+$/.test(a) && !['--max', '--max-survive', '--timeout'].includes(argv[i - 1]),
  )
  if (!targets.length) {
    console.error('用法：node packages/core/tools/mutate.mjs <src 相对路径...> [--list] [--max n] [--json] [--strict]')
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
  cpSync(join(REPO, 'packages'), join(work, 'packages'), { recursive: true })
  try {
    cpSync(join(REPO, 'package.json'), join(work, 'package.json'))
  } catch {
    /* package.json 不是必需 */
  }

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
