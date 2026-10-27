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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// A/B 对照（2026-10-18）：A 组 = FG 关闭（不装监听，等价于插件禁用）；B 组 = FG 开启。
// `--control` 只跑 A 组；`--ab` 同时跑两组并逐调用对照。
const controlOnly = args.includes('--control')
const ab = args.includes('--ab')
const listener = preExecuteListener({ warn: () => {} })
const passThrough = async () => ({ kind: 'allow' })
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

/**
 * 跑一遍全部组。
 * @param {(exec:object)=>Promise<object>} gate 判定函数（FG 开=真实监听；关=直通）
 */
async function runPass(gate) {
  const callResults = []
  const groupResults = []
  const latencies = []
  for (const group of groups) {
    const failures = []
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
        out = await gate(exec)
      } catch (error) {
        out = { kind: 'error', reason: String((error && error.message) || error) }
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      latencies.push(ms)
      const kind = out && out.kind ? out.kind : 'allow'
      const reason = String((out && out.reason) || '')
      const kindOk = kind === call.expect
      const reasonOk = !call.reason || new RegExp(call.reason).test(reason)
      const pass = kindOk && reasonOk
      callResults.push({ group: group.id, step, tool: call.tool, expect: call.expect, got: kind, reason, ms: Number(ms.toFixed(2)), pass })
      if (!pass) {
        failures.push(`step${step} ${call.tool} 期望 ${call.expect} 实际 ${kind}${call.reason ? ` / 理由需匹配 ${call.reason}` : ''} | ${reason.slice(0, 110)}`)
      }
    }
    groupResults.push({ id: group.id, goal: group.goal, calls: group.calls.length, pass: failures.length === 0, failures })
  }
  latencies.sort((a, b) => a - b)
  const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))]
  return {
    calls: callResults,
    groups: groupResults,
    latencyMs: { p50: Number(at(50).toFixed(2)), p95: Number(at(95).toFixed(2)) },
  }
}

const gateOn = (exec) => listener(exec, allow)
const gateOff = () => passThrough()

if (ab) {
  // A 组 = FG 关（直通），B 组 = FG 开（真实监听）
  const a = await runPass(gateOff)
  const b = await runPass(gateOn)
  const blocked = b.calls.filter((c) => c.got !== 'allow')
  const aPass = a.calls.length
  const bPass = b.calls.filter((c) => c.pass).length
  if (jsonOut) {
    console.log(JSON.stringify({ a: { calls: a.calls.length, latencyMs: a.latencyMs }, b: { ...b, blocked: blocked.map(({ group, step, tool, expect, got, reason }) => ({ group, step, tool, expect, got, reason: reason.slice(0, 90) })) } }, null, 2))
  } else {
    console.log(`A/B 对照：${groups.length} 组 / ${a.calls.length} 次调用`)
    console.log(`  A 组（FG 关）  可完成 ${aPass}/${a.calls.length}   延迟 p50 ${a.latencyMs.p50}ms / p95 ${a.latencyMs.p95}ms`)
    console.log(`  B 组（FG 开）  合规 ${bPass}/${b.calls.length}   延迟 p50 ${b.latencyMs.p50}ms / p95 ${b.latencyMs.p95}ms`)
    console.log(`  FG 介入        ${blocked.length} 次拦截（其中应当拦 ${blocked.filter((c) => c.expect !== 'allow').length} / 误伤 ${blocked.filter((c) => c.expect === 'allow').length}）`)
    console.log(`  热路径开销     p50 +${(b.latencyMs.p50 - a.latencyMs.p50).toFixed(2)}ms / p95 +${(b.latencyMs.p95 - a.latencyMs.p95).toFixed(2)}ms`)
    if (blocked.length > 0) {
      console.log('  拦截清单：')
      for (const c of blocked) {
        const tag = c.expect === 'allow' ? '误伤' : '应拦'
        console.log(`    ${c.group} step${c.step} ${c.tool} [${tag}] ${c.got} | ${c.reason.slice(0, 80)}`)
      }
    }
  }
  rmSync(WORK, { recursive: true, force: true })
  process.exit(0)
}

const single = controlOnly ? await runPass(gateOff) : await runPass(gateOn)
const callResults = single.calls
const groupResults = single.groups

const totalCalls = callResults.length
const passedCalls = callResults.filter((c) => c.pass).length
const passedGroups = groupResults.filter((g) => g.pass).length
const falsePositives = callResults.filter((c) => c.expect === 'allow' && !c.pass).length
const missed = callResults.filter((c) => c.expect !== 'allow' && !c.pass).length

const report = {
  ts: new Date().toISOString(),
  groups: groupResults.length,
  calls: totalCalls,
  groupPassRate: Number((passedGroups / groupResults.length).toFixed(4)),
  callAccuracy: Number((passedCalls / totalCalls).toFixed(4)),
  falsePositives,
  missed,
  latencyMs: single.latencyMs,
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
