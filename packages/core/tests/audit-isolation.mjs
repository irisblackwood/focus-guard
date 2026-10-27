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
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const realAudit = join(repoRoot, '.focus-guard', 'AUDIT.log')

/** @returns {{lines: number, bytes: number}} */
function snapshot(file) {
  if (!existsSync(file)) return { lines: 0, bytes: 0 }
  const raw = readFileSync(file, 'utf8')
  // 行数口径 = 换行符个数 + 末尾残余；不用 split('\n')，避免最后一行空串多算一行。
  const lines = raw === '' ? 0 : raw.split('\n').filter(Boolean).length
  return { lines, bytes: statSync(file).size }
}

const before = snapshot(realAudit)

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

const run = wrapped
  ? spawnSync(wrapped, { cwd: repoRoot, stdio: 'inherit', shell: true, env: childEnv })
  : spawnSync('node', ['--test', ...files], { cwd: repoRoot, stdio: 'inherit', env: childEnv })
const after = snapshot(realAudit)

console.log(
  `[audit-isolation] 运行后：${after.lines} 行 / ${after.bytes} 字节（Δ 行 ${after.lines - before.lines} / Δ 字节 ${after.bytes - before.bytes}）`,
)

if (run.error) {
  console.error('[audit-isolation] 测试进程启动失败：', run.error.message)
  process.exit(1)
}
if (run.status !== 0) {
  console.error(`[audit-isolation] 测试本身失败（exit ${run.status}）；隔离结论仍取实测增量`)
}

const grew = after.lines > before.lines || after.bytes > before.bytes
if (!grew) {
  console.log(`[audit-isolation] PASS：${wrapped ? '整条命令链' : '测试与自检'}对真实 AUDIT.log 零增长`)
  process.exit(run.status === 0 ? 0 : 1)
}
if (process.env.FG_ALLOW_AUDIT_GROWTH === '1') {
  console.warn('[audit-isolation] WARN：审计有增长，但 FG_ALLOW_AUDIT_GROWTH=1 放行')
  process.exit(run.status === 0 ? 0 : 1)
}

console.error('[audit-isolation] FAIL：测试往真实 AUDIT.log 写了东西 —— 说明某条路径漏了 FG_AUDIT_FILE 重定向。')
console.error(`[audit-isolation] 目标文件：${realAudit}`)
console.error('[audit-isolation] 排查线索：deny/compaction-watch-ready 行的 session 字段通常是测试 sid 或 dsh-native。')
process.exit(1)
