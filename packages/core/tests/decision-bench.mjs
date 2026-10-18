#!/usr/bin/env node
/**
 * FocusGuard · 判定基准（decision bench）
 *
 * 回答三个问题：
 *   ① 准确率：给定这批输入，判定是否与期望一致（防逻辑退化）
 *   ② 误伤率：期望放行的用例被拦掉的比例（这是 FG 最大的成本）
 *   ③ 延迟：判定在工具调用热路径上，p50/p95 必须可预期
 *
 * 用法：
 *   node tests/decision-bench.mjs            # 跑并对比基线
 *   node tests/decision-bench.mjs --update   # 用本次结果覆盖基线
 *   node tests/decision-bench.mjs --json     # 机器可读
 *
 * 纪律：审计与状态一律重定向到 tmpdir，绝不碰真实工作区（2026-10-09 污染事故教训）。
 * 退出码：0 通过 / 1 不达基线 / 2 环境准备失败
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(here, '..', 'docs', 'BENCH-BASELINE.json')
const ITERATIONS = Number(process.env.FG_BENCH_ITER) || 10
// Bash 类命令会进第 2 层语义判定（python 哨兵 ≈60ms/次），阈值按含哨兵的实际路径设定；
// 非 Bash 工具实测 p95 < 3ms —— 见输出里的 byCase / slowest。
const P95_LIMIT_MS = Number(process.env.FG_BENCH_P95_MS) || 100
const ACCURACY_MIN = 1 // 这批用例是确定性的，必须全对；误伤单独统计

const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const update = args.includes('--update')

// ── 隔离：审计/状态/卷宗全部指向 tmpdir ──
const WORK = mkdtempSync(join(tmpdir(), 'fg-bench-'))
process.env.FG_AUDIT_FILE = join(WORK, 'AUDIT.log')
process.env.FG_CASE_FILE = join(WORK, 'CASE_FILE.md')
process.env.FG_SHELL = ''

/** 环境指纹夹具：hardCheck 依赖它（cat→bat / grep→rg）。CI 检出里没有 .ai/，必须自建。 */
const FP_DIR = join(WORK, 'fp')
mkdirSync(join(FP_DIR, '.ai'), { recursive: true })
writeFileSync(join(FP_DIR, '.ai', 'env-fingerprint.json'), JSON.stringify({ map: { cat: 'bat', grep: 'rg', find: 'fd' } }))

/** 大文件夹具（>300 行触发整文件闸）与小文件对照 */
const BIG = join(FP_DIR, 'big.mjs')
const SMALL = join(FP_DIR, 'small.mjs')
const README = join(FP_DIR, 'README.md')
writeFileSync(BIG, Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`).join('\n'))
writeFileSync(SMALL, '// tiny\n')
writeFileSync(README, '# fixture\n')

const { preExecuteListener } = await import('../src/dsh/pipeline.mjs')
const { statePath, saveState } = await import('../src/core/state.mjs')

const allow = () => ({ kind: 'allow' })

/** @type {Array<{id:string, tool:string, args:object, expectKind:string, expectReason?:RegExp, seedState?:boolean}>} */
const CASES = [
  // 红线层：必须 deny，且理由指向绝对红线
  { id: 'redline-rm-rf-root', tool: 'Bash', args: { command: 'rm ' + '-rf /' }, expectKind: 'deny', expectReason: /绝对红线/ },
  { id: 'redline-git-push-force', tool: 'Bash', args: { command: 'git push ' + '--force origin main' }, expectKind: 'deny', expectReason: /绝对红线/ },
  // 第 1.5 层硬校验：环境替代
  { id: 'hardcheck-cat', tool: 'Bash', args: { command: 'cat big.log' }, expectKind: 'deny', expectReason: /bat|环境/ },
  // 第 1.4 层整文件闸
  { id: 'whole-file-deny', tool: 'Read', args: { file_path: BIG }, expectKind: 'deny', expectReason: /XERJ|offset|limit|整文件/ },
  { id: 'whole-file-offset-allow', tool: 'Read', args: { file_path: BIG, offset: 1, limit: 50 }, expectKind: 'allow' },
  { id: 'small-file-allow', tool: 'Read', args: { file_path: SMALL }, expectKind: 'allow' },
  // 体积闸：Grep content 无 head_limit
  { id: 'grep-content-deny', tool: 'Grep', args: { pattern: 'x', output_mode: 'content' }, expectKind: 'deny', expectReason: /head_limit|限量/ },
  { id: 'grep-default-allow', tool: 'Grep', args: { pattern: 'x' }, expectKind: 'allow' },
  // 资格闸：高危工具无授权
  { id: 'eligibility-publish-deny', tool: 'Bash', args: { command: 'npm ' + 'pub' + 'lish --access public' }, expectKind: 'deny', expectReason: /fg_apply/ },
  // 取证闸：已有会话状态 + 未读即改 → 拦。第 3 层对"本会话尚无状态文件"是**显式 fail-open**
  // （pipeline.mjs:352-355），所以必须 seed 一个空状态文件才测得到这条闸。
  { id: 'evidence-edit-deny', tool: 'Edit', args: { file_path: README }, expectKind: 'deny', expectReason: /取证|未读/, seedState: true },
  { id: 'evidence-new-session-allow', tool: 'Edit', args: { file_path: README }, expectKind: 'allow' },
  // 基线放行：常见正常操作不得误伤
  { id: 'plain-ls-allow', tool: 'Bash', args: { command: 'ls -la' }, expectKind: 'allow' },
  { id: 'plain-git-status-allow', tool: 'Bash', args: { command: 'git status --short' }, expectKind: 'allow' },
  { id: 'write-new-file-allow', tool: 'Write', args: { file_path: join(FP_DIR, 'brand-new.txt') }, expectKind: 'allow' },
]

function execFor(id, tool, toolArgs, sessionId) {
  return {
    sessionId,
    name: tool,
    arguments: toolArgs,
    agent: { model: 'deepseek-flash', session: { header: { cwd: FP_DIR, id: sessionId } } },
  }
}

const listener = preExecuteListener({ warn: () => {} })

const allowCases = CASES.filter((c) => c.expectKind === 'allow').length

// 预热一轮（不计入延迟）：首次调用会触发环境探测/模块解析，属会话级一次性成本，
// 混进 p95 会把"热路径 0.5ms"错报成 60ms（本基准第一版就踩了）。
for (const c of CASES) {
  await listener(execFor(c.id, c.tool, c.args, `bench-warmup-${c.id}`), allow)
}

const durations = []
const caseDurations = new Map()
const results = []
let correct = 0
let falsePositives = 0

for (let iter = 0; iter < ITERATIONS; iter += 1) {
  for (const c of CASES) {
    const sessionId = `bench-${iter}-${c.id}`
    // 每次调用都换会话，避免授权/取证状态跨用例串味。
    // seedState 用于测"已有会话但未取证"的那条分支（无状态文件是显式 fail-open）。
    if (c.seedState) saveState(statePath(sessionId), { fused: false, probation: false, readSet: {} })
    const t0 = process.hrtime.bigint()
    const out = await listener(execFor(c.id, c.tool, c.args, sessionId), allow)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    durations.push(ms)
    if (!caseDurations.has(c.id)) caseDurations.set(c.id, [])
    caseDurations.get(c.id).push(ms)

    const kind = out && out.kind ? out.kind : 'allow'
    const okKind = kind === c.expectKind
    const okReason = !c.expectReason || c.expectReason.test(String(out && out.reason ? out.reason : ''))
    const pass = okKind && okReason
    if (pass) correct += 1
    if (c.expectKind === 'allow' && !pass) falsePositives += 1
    if (iter === 0) {
      results.push({ id: c.id, expect: c.expectKind, got: kind, pass, reason: String((out && out.reason) || '').slice(0, 120) })
    }
  }
}

const total = ITERATIONS * CASES.length
durations.sort((a, b) => a - b)
const pct = (p) => durations[Math.min(durations.length - 1, Math.floor((durations.length * p) / 100))]
const accuracy = correct / total
const fpRate = allowCases === 0 ? 0 : falsePositives / (allowCases * ITERATIONS)
const p50 = pct(50)
const p95 = pct(95)
const max = durations[durations.length - 1]

// 每用例耗时（定位是谁拖慢热路径）
const byCase = new Map()
for (const [id, list] of caseDurations) {
  const sorted = list.slice().sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
  byCase.set(id, { p50: Number(at(50).toFixed(2)), p95: Number(at(95).toFixed(2)) })
}
const slowest = [...byCase.entries()].sort((a, b) => b[1].p95 - a[1].p95).slice(0, 3)

const report = {
  ts: new Date().toISOString(),
  iterations: ITERATIONS,
  cases: CASES.length,
  calls: total,
  accuracy: Number(accuracy.toFixed(4)),
  falsePositiveRate: Number(fpRate.toFixed(4)),
  latencyMs: { p50: Number(p50.toFixed(2)), p95: Number(p95.toFixed(2)), max: Number(max.toFixed(2)) },
  byCase: Object.fromEntries(byCase),
  slowest: slowest.map(([id, v]) => ({ id, ...v })),
  failures: results.filter((r) => !r.pass),
}

if (update) {
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, JSON.stringify(report, null, 2) + '\n')
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null

const failures = []
if (accuracy < ACCURACY_MIN) failures.push(`准确率 ${report.accuracy} < ${ACCURACY_MIN}`)
if (baseline) {
  if (report.accuracy < baseline.accuracy - 0.02) failures.push(`准确率较基线下降：${baseline.accuracy} → ${report.accuracy}`)
  if (report.latencyMs.p95 > baseline.latencyMs.p95 * 3 + 5) {
    failures.push(`p95 明显劣化：${baseline.latencyMs.p95}ms → ${report.latencyMs.p95}ms`)
  }
}
if (report.latencyMs.p95 > P95_LIMIT_MS) failures.push(`p95 ${report.latencyMs.p95}ms > 阈值 ${P95_LIMIT_MS}ms`)

if (jsonOut) {
  console.log(JSON.stringify({ ...report, baseline, ok: failures.length === 0, failures }, null, 2))
} else {
  console.log(`判定基准：${CASES.length} 用例 × ${ITERATIONS} 轮 = ${total} 次调用`)
  console.log(`  准确率      ${(accuracy * 100).toFixed(2)}%`)
  console.log(`  误伤率      ${(fpRate * 100).toFixed(2)}%（期望放行却被拦）`)
  console.log(`  延迟        p50 ${report.latencyMs.p50}ms / p95 ${report.latencyMs.p95}ms / max ${report.latencyMs.max}ms`)
  if (baseline) console.log(`  基线        accuracy ${baseline.accuracy} / p95 ${baseline.latencyMs.p95}ms（${baseline.ts}）`)
  if (report.failures.length > 0) {
    console.log('  失败用例：')
    for (const f of report.failures) console.log(`    ✗ ${f.id} 期望 ${f.expect} 实际 ${f.got} | ${f.reason}`)
  }
  if (failures.length > 0) {
    console.log('  不达基线：')
    for (const f of failures) console.log(`    ✗ ${f}`)
  } else {
    console.log('  PASS')
  }
}

rmSync(WORK, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
