#!/usr/bin/env node
/**
 * FocusGuard · 任务测试 50 组（B 组：FG 环境实跑，零 API 花费）
 *
 * 与 decision-bench 的区别：那个测"单条判定准不准"，这个测"一整件任务能不能在 FG 下走通"——
 * 一组任务 = 一串真实调用（读→改→跑→查），任何一环被错拦，整组就算失败（误伤）。
 *
 * 数据：`tests/task-suite.json`（50 组，按只读/改代码/命令/高危/资格/边界分组）
 * 用法：
 *   node tests/task-bench.mjs            # 组通过率 + 逐条失败原因
 *   node tests/task-bench.mjs --json
 *   node tests/task-bench.mjs --group T31
 *
 * 纪律：审计/卷宗一律重定向 tmpdir；每次调用用独立会话，避免授权与取证状态互相污染。
 * 退出码：0 全组通过 / 1 有失败组
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SUITE = join(here, 'task-suite.json')
const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const onlyIdx = args.indexOf('--group')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

const WORK = mkdtempSync(join(tmpdir(), 'fg-tasks-'))
process.env.FG_AUDIT_FILE = join(WORK, 'AUDIT.log')
process.env.FG_CASE_FILE = join(WORK, 'CASE_FILE.md')
process.env.FG_SHELL = ''

// ── 夹具 ──
const FIX = join(WORK, 'fx')
mkdirSync(join(FIX, '.ai'), { recursive: true })
mkdirSync(join(FIX, '.github', 'workflows'), { recursive: true })
writeFileSync(join(FIX, '.ai', 'env-fingerprint.json'), JSON.stringify({ map: { cat: 'bat', grep: 'rg', find: 'fd' } }))
writeFileSync(join(FIX, 'small.mjs'), '// small\n')
writeFileSync(join(FIX, 'big.mjs'), Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`).join('\n'))
writeFileSync(join(FIX, 'README.md'), '# readme\n')
writeFileSync(join(FIX, '中文文件.md'), '# 中文\n')
writeFileSync(join(FIX, 'a file with space.md'), '# space\n')
writeFileSync(join(FIX, '.env'), 'TOKEN=x\n')
writeFileSync(join(FIX, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
writeFileSync(join(FIX, 'big.md'), '# big\n' + 'x\n'.repeat(1000))

const PATHS = {
  small: join(FIX, 'small.mjs'),
  big: join(FIX, 'big.mjs'),
  readme: join(FIX, 'README.md'),
  zh: join(FIX, '中文文件.md'),
  space: join(FIX, 'a file with space.md'),
  env: join(FIX, '.env'),
  workflow: join(FIX, '.github', 'workflows', 'ci.yml'),
  fresh: join(FIX, 'brand-new.txt'),
  deep: join(FIX, 'a', 'b', 'c', 'new.txt'),
  'large-md': join(FIX, 'big.md'),
}

const { preExecuteListener } = await import('../src/dsh/pipeline.mjs')
const { statePath, saveState } = await import('../src/core/state.mjs')

const listener = preExecuteListener({ warn: () => {} })
const allow = () => ({ kind: 'allow' })

/** 把用例里简写的 call 展开成真实工具参数。 */
function toExecArgs(call) {
  if (call.args) return call.args
  if (call.file) {
    const p = PATHS[call.file] || call.file
    if (call.tool === 'Read') return { file_path: p, ...(call.extra || {}) }
    return { file_path: p, ...(call.extra || {}) }
  }
  return call.extra || {}
}

const suite = JSON.parse(readFileSync(SUITE, 'utf8'))
const groups = only ? suite.filter((g) => g.id === only) : suite

const callResults = []
const groupResults = []
const latencies = []

let groupIndex = 0
for (const group of groups) {
  groupIndex += 1
  const failures = []
  let calls = 0
  let step = 0
  for (const call of group.calls) {
    step += 1
    const sessionId = `task-${group.id}-${process.pid}`
    if (call.seed) saveState(statePath(sessionId), { fused: false, probation: false, readSet: {} })
    const exec = {
      sessionId,
      name: call.tool,
      arguments: toExecArgs(call),
      agent: { model: 'deepseek-flash', session: { header: { cwd: FIX, id: sessionId } } },
    }
    const t0 = process.hrtime.bigint()
    let out
    try {
      out = await listener(exec, allow)
    } catch (error) {
      out = { kind: 'error', reason: String((error && error.message) || error) }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    latencies.push(ms)
    calls += 1

    const kind = out && out.kind ? out.kind : 'allow'
    const reason = String((out && out.reason) || '')
    const kindOk = kind === call.expect
    const reasonOk = !call.reason || new RegExp(call.reason).test(reason)
    const pass = kindOk && reasonOk
    callResults.push({ group: group.id, step, tool: call.tool, expect: call.expect, got: kind, ms: Number(ms.toFixed(2)), pass })
    if (!pass) {
      failures.push(`step${step} ${call.tool} 期望 ${call.expect} 实际 ${kind}${call.reason ? ` / 理由需匹配 ${call.reason}` : ''} | ${reason.slice(0, 110)}`)
    }
  }
  groupResults.push({ id: group.id, goal: group.goal, calls, pass: failures.length === 0, failures })
}

const totalCalls = callResults.length
const passedCalls = callResults.filter((c) => c.pass).length
const passedGroups = groupResults.filter((g) => g.pass).length
const falsePositives = callResults.filter((c) => c.expect === 'allow' && !c.pass).length
const missed = callResults.filter((c) => c.expect !== 'allow' && !c.pass).length
latencies.sort((a, b) => a - b)
const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))]

const report = {
  ts: new Date().toISOString(),
  groups: groupResults.length,
  calls: totalCalls,
  groupPassRate: Number((passedGroups / groupResults.length).toFixed(4)),
  callAccuracy: Number((passedCalls / totalCalls).toFixed(4)),
  falsePositives,
  missed,
  latencyMs: { p50: Number(at(50).toFixed(2)), p95: Number(at(95).toFixed(2)) },
  failures: groupResults.filter((g) => !g.pass),
}

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`任务测试：${report.groups} 组 / ${report.calls} 次调用`)
  console.log(`  组通过率    ${(report.groupPassRate * 100).toFixed(2)}%（${passedGroups}/${groupResults.length}）`)
  console.log(`  调用准确率  ${(report.callAccuracy * 100).toFixed(2)}%`)
  console.log(`  误伤        ${falsePositives}（期望放行却被拦）`)
  console.log(`  漏拦        ${missed}（期望拦截却放行）`)
  console.log(`  延迟        p50 ${report.latencyMs.p50}ms / p95 ${report.latencyMs.p95}ms`)
  if (report.failures.length > 0) {
    console.log('  失败组：')
    for (const f of report.failures) {
      console.log(`    ✗ ${f.id} ${f.goal}`)
      for (const line of f.failures) console.log(`        ${line}`)
    }
  }
}

rmSync(WORK, { recursive: true, force: true })
process.exit(report.failures.length === 0 ? 0 : 1)
