#!/usr/bin/env node
/**
 * 审计隔离守卫（2026-10-18）
 *
 * 作用：跑测试前给真实 `AUDIT.log` 拍快照，跑完再拍一次；**有增长就 exit 1**。
 *
 * 为什么需要它：隔离是"某次修好了"，不是"永远修好了"。同一类事故已经发生过两次——
 *   · 2026-10-09：套件把审计写进真实工作区，污染 2630 行 / 746 个测试 session；
 *   · 2026-10-18：自检每次 apply() 往真实审计写一条带假 pid 的 compaction-watch-ready，刷了 10 条。
 * 两次都是"某条路径忘了重定向"，靠人盯着不现实，所以把它变成一条会红的断言。
 *
 * 用法：
 *   node tests/audit-isolation.mjs                        # 跑同目录全部 *.test.mjs
 *   node tests/audit-isolation.mjs -- <args>              # 透传给 node --test
 *   node tests/audit-isolation.mjs --wrap "<命令>"        # 包裹任意命令（2026-10-27 新增）
 *   FG_ALLOW_AUDIT_GROWTH=1 …                             # 临时放行（排查用，不提交）
 *
 * 2026-10-27 补第三个缺口：守卫此前只包住 `test:all`，而 `npm run check` 里还有
 * eval / selftest / bridges 三段在守卫**外面**。实测 `npm run eval` 单独一次就往真实
 * `AUDIT.log` 写 62 行（threat-eval 用裸 execFileSync，子进程继承了宿主的
 * `CLAUDE_PROJECT_DIR`）。已修 threat-eval 并加 `--wrap` 模式，让整条 check 链都在守卫内。
 * 教训同源：**"隔离"必须包住整条链，只包住自己那一环等于没包。**
 *
 * 2026-10-27 补第四个缺口：**只比行数会把宿主的正常写入算成隔离失效**。
 * 实测一次 `npm run check` 报 Δ 3 行，逐条核对后发现是宿主进程（`status.json` 的 pid 22660、
 * `compaction-watch-ready` 的 ts 与 `started_at` 差 1ms）在跑 check 期间自己写的——
 * 与测试无关。这种假阳性比不检查更糟：它会训练人用 `FG_ALLOW_AUDIT_GROWTH=1` 绕过。
 * 修法：`audit()` 落一行 `run` 字段（取 `FG_RUN_ID`），守卫给子进程注入批次号，
 * **只把带本批次号的行算作"测试写的"**；其余如实报为"宿主并发写入，不计"。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const realAudit = join(repoRoot, '.focus-guard', 'AUDIT.log')

/**
 * 记录面隔离（2026-10-29 补第五个缺口）。
 *
 * 病根：守卫此前只盯 `AUDIT.log`，于是"测试写真实记录文件"只要换了文件就看不见——
 * 实测 `npm run test:all` 会改写 `.focus-guard/approvals/pending_request.json`（md5 变化）
 * 和 `.ai/CASE_FILE.md` 的【四】额度台账，而守卫照样报「零增长 PASS」。
 * **只包住一个文件等于没包住记录面。**
 *
 * 分两档（为什么不一律硬红）：
 *   · `hard`：宿主只在拦截时才写审批、只有工具才写面板记录 → 变了必是测试漏重定向，硬红。
 *   · `soft`：卷宗与工作区快照**宿主自己也在写**（回合结束写【四】、记决策写 workspace.json）。
 *     硬红会变成假阳性，而假阳性会训练人加绕过开关——那比不检查更糟。故只报不拦，
 *     同时由 `seams.test.mjs` / `state-ownership.test.mjs` 里那两条"真实工作区未被触碰"用例硬兜。
 */
const RECORD_HARD = ['.focus-guard/approvals', 'panel-runs.json']
const RECORD_SOFT = ['.ai/CASE_FILE.md', '.focus-guard/workspace.json']

/** 递归收集文件 → md5。目录不存在时返回空。 */
function hashTree(rel) {
  const out = new Map()
  const walk = (abs, key) => {
    let st
    try {
      st = statSync(abs)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(abs)) walk(join(abs, e), `${key}/${e}`)
      return
    }
    try {
      out.set(key, createHash('md5').update(readFileSync(abs)).digest('hex'))
    } catch {
      out.set(key, 'ERR')
    }
  }
  walk(join(repoRoot, rel), rel)
  return out
}

function hashAll(list) {
  const m = new Map()
  for (const rel of list) for (const [k, v] of hashTree(rel)) m.set(k, v)
  return m
}

/** 对比两次快照，返回被改写/新增/消失的相对路径。 */
function diffHash(before, after) {
  const changed = []
  for (const [k, v] of after) if (before.get(k) !== v) changed.push(before.has(k) ? `改写 ${k}` : `新增 ${k}`)
  for (const k of before.keys()) if (!after.has(k)) changed.push(`消失 ${k}`)
  return changed
}

/** 本次运行批次号：注入子进程环境，只有带它的审计行才算"测试链写的" */
const runId = `iso-${process.pid}-${Date.now().toString(36)}`

/** @returns {{lines: number, bytes: number}} */
function snapshot(file) {
  if (!existsSync(file)) return { lines: 0, bytes: 0 }
  const raw = readFileSync(file, 'utf8')
  // 行数口径 = 换行符个数 + 末尾残余；不用 split('\n')，避免最后一行空串多算一行。
  const lines = raw === '' ? 0 : raw.split('\n').filter(Boolean).length
  return { lines, bytes: statSync(file).size }
}

/** 基线之后新增的原始行（按行数切，不按内容猜） */
function linesAfter(file, beforeLines) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(beforeLines)
}

const before = snapshot(realAudit)
const beforeHard = hashAll(RECORD_HARD)
const beforeSoft = hashAll(RECORD_SOFT)

const wrapIdx = process.argv.indexOf('--wrap')
const wrapped = wrapIdx >= 0 ? process.argv[wrapIdx + 1] : null
const passthrough = process.argv.slice(2)
const files =
  wrapped || passthrough[0] === '--'
    ? []
    : readdirSync(here)
        .filter((f) => f.endsWith('.test.mjs'))
        .sort()
        .map((f) => join(here, f))

console.log(`[audit-isolation] 真实审计基线：${before.lines} 行 / ${before.bytes} 字节`)
if (wrapped) console.log(`[audit-isolation] 包裹模式：${wrapped}`)
else console.log(`[audit-isolation] 运行 ${files.length} 个测试文件`)

// 子进程环境必须和终端一致（2026-10-27）：`NODE_TEST_CONTEXT` 在 `node --test` 里会被设成
// `child-v8`，子进程继承后 `node --test` 会**恒 exit 0**，哪怕测试明确失败。
// `tools/mutate.mjs` 上踩过这个坑（变异体全被判"存活"，得分是假的）。
// 本文件目前是顶层运行器、不受影响，但一旦有人从测试里调它就会静默失效，所以一并剔掉。
const childEnv = { ...process.env }
delete childEnv.NODE_TEST_CONTEXT
childEnv.FG_RUN_ID = runId

const run = wrapped
  ? spawnSync(wrapped, { cwd: repoRoot, stdio: 'inherit', shell: true, env: childEnv })
  : spawnSync('node', ['--test', ...files], { cwd: repoRoot, stdio: 'inherit', env: childEnv })
const after = snapshot(realAudit)
const added = linesAfter(realAudit, before.lines)
const mine = added.filter((l) => l.includes(`"run":"${runId}"`))
const foreign = added.length - mine.length
const hardChanged = diffHash(beforeHard, hashAll(RECORD_HARD))
const softChanged = diffHash(beforeSoft, hashAll(RECORD_SOFT))

console.log(
  `[audit-isolation] 运行后：${after.lines} 行 / ${after.bytes} 字节（Δ 行 ${after.lines - before.lines} / Δ 字节 ${after.bytes - before.bytes}；其中本批次 ${mine.length} 条）`,
)
if (foreign > 0)
  console.log(
    `[audit-isolation] 另有 ${foreign} 条来自宿主进程并发写入（批次号不匹配），不计入隔离结论`,
  )
if (hardChanged.length)
  console.error(`[audit-isolation] 记录面被改写（${hardChanged.length} 处）：`)
for (const c of hardChanged.slice(0, 6)) console.error(`[audit-isolation]   ${c}`)
if (softChanged.length)
  console.warn(
    `[audit-isolation] 另有 ${softChanged.length} 处软记录变化（宿主也可能写，仅供参考）：${softChanged.slice(0, 4).join('、')}`,
  )
else if (!hardChanged.length)
  console.log(`[audit-isolation] 记录面（审批 / 面板 / 卷宗 / 工作区快照）零变化`)

if (run.error) {
  console.error('[audit-isolation] 测试进程启动失败：', run.error.message)
  process.exit(1)
}
if (run.status !== 0) {
  console.error(`[audit-isolation] 测试本身失败（exit ${run.status}）；隔离结论仍取实测增量`)
}

if (hardChanged.length) {
  console.error(
    `[audit-isolation] FAIL：测试链改写了真实记录文件 —— 说明某条路径漏了 FG_APPROVAL_DIR / FG_CASE_FILE 重定向。`,
  )
  for (const c of hardChanged.slice(0, 6)) console.error(`[audit-isolation]   ${c}`)
  process.exit(1)
}

if (mine.length === 0) {
  console.log(`[audit-isolation] PASS：${wrapped ? '整条命令链' : '测试与自检'}对真实 AUDIT.log 零增长`)
  process.exit(run.status === 0 ? 0 : 1)
}
if (process.env.FG_ALLOW_AUDIT_GROWTH === '1') {
  console.warn('[audit-isolation] WARN：审计有增长，但 FG_ALLOW_AUDIT_GROWTH=1 放行')
  process.exit(run.status === 0 ? 0 : 1)
}

console.error(
  `[audit-isolation] FAIL：测试链往真实 AUDIT.log 写了 ${mine.length} 行 —— 说明某条路径漏了 FG_AUDIT_FILE 重定向。`,
)
console.error(`[audit-isolation] 目标文件：${realAudit}`)
for (const l of mine.slice(0, 3)) console.error(`[audit-isolation]   ${l.slice(0, 160)}`)
process.exit(1)
