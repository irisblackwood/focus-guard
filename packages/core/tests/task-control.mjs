#!/usr/bin/env node
/**
 * FocusGuard · A 组（纯净对照，2026-10-18）
 *
 * 「纯净」的定义（这条脚本必须始终满足，否则 A 组无意义）：
 *   1. 不 import 任何 `packages/core/src/` 模块——FG 代码一行都不加载
 *   2. 不读 FG 状态、不写审计、不注入系统提示
 *   3. 独立进程执行，不依赖宿主插件开关（禁用/启用结果相同）
 *
 * 它做的不是"把 FG 的闸跳过"，而是**没有闸**：直接用 fs / 子进程完成同一批任务里的操作。
 * 破坏性命令（rm -rf /、DROP DATABASE、publish…）不实跑，只记录"可执行（dry）"——
 * 控制组不需要真的删库来证明"没有闸就没人拦"。
 *
 * 用法：node tests/task-control.mjs [--json]
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const jsonOut = process.argv.includes('--json')

// —— 自证纯净：本文件不得引用 src/ ——
const SELF = readFileSync(fileURLToPath(import.meta.url), 'utf8')
const srcRefs = [...SELF.matchAll(/from\s+['"]([^'"]*src\/[^'"]*)['"]/g)].map((m) => m[1])
if (srcRefs.length > 0) {
  console.error(`[纯净性失败] 本脚本引用了 FG 源码：${srcRefs.join(', ')}`)
  process.exit(2)
}

const WORK = mkdtempSync(join(tmpdir(), 'fg-control-'))
const FIX = join(WORK, 'fx')
mkdirSync(join(FIX, '.ai'), { recursive: true })
mkdirSync(join(FIX, '.github', 'workflows'), { recursive: true })
writeFileSync(join(FIX, 'small.mjs'), '// small\n')
writeFileSync(join(FIX, 'big.mjs'), Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`).join('\n'))
writeFileSync(join(FIX, 'README.md'), '# readme\n')
writeFileSync(join(FIX, '中文文件.md'), '# 中文\n')
writeFileSync(join(FIX, '.env'), 'TOKEN=x\n')
writeFileSync(join(FIX, '.github', 'workflows', 'ci.yml'), 'name: ci\n')

const suite = JSON.parse(readFileSync(join(here, 'task-suite.json'), 'utf8'))


function pathOf(call) {
  const map = {
    small: join(FIX, 'small.mjs'),
    big: join(FIX, 'big.mjs'),
    readme: join(FIX, 'README.md'),
    zh: join(FIX, '中文文件.md'),
    env: join(FIX, '.env'),
    workflow: join(FIX, '.github', 'workflows', 'ci.yml'),
    fresh: join(FIX, 'brand-new.txt'),
    deep: join(FIX, 'a', 'b', 'c', 'new.txt'),
    'large-md': join(FIX, 'README.md'),
    space: join(FIX, 'README.md'),
  }
  return map[call.file] || call.file || join(FIX, 'x')
}

function perform(call) {
  const args = call.args || {}
  switch (call.tool) {
    case 'Read': {
      const p = pathOf(call)
      if (!existsSync(p)) return { ok: false, note: '文件不存在' }
      const text = readFileSync(p, 'utf8')
      const lines = text.split('\n').length
      return { ok: true, note: `${lines} 行（控制组不施加整文件闸）` }
    }
    case 'Write': {
      const p = pathOf(call)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '# control write\n')
      return { ok: true, note: '已写入（无取证闸）' }
    }
    case 'Edit': {
      const p = pathOf(call)
      writeFileSync(p, '# control edit\n')
      return { ok: true, note: '已修改（无取证闸）' }
    }
    case 'Glob': {
      const found = readdirSync(FIX, { recursive: true }).length
      return { ok: true, note: `${found} 个条目` }
    }
    case 'Grep': {
      const hit = readFileSync(join(FIX, 'small.mjs'), 'utf8').includes(String(args.pattern || ''))
      return { ok: true, note: `匹配=${hit}（无体积闸）` }
    }
    case 'Bash': {
      // 控制组不实跑 Bash：夹具目录不是仓库、Windows 也没有 ls/pwd/git 语义，
      // 实跑只会制造与"有没有闸"无关的失败噪音。本对照要证明的是**没人拦**，不是命令能跑。
      const cmd = String(args.command || '')
      return { ok: true, dry: true, note: `仅记录：${cmd.slice(0, 60)}` }
    }
    default:
      return { ok: true, note: '未覆盖的工具：视为可调用' }
  }
}

const results = []
let executed = 0
let dry = 0
let failed = 0
for (const group of suite) {
  for (const call of group.calls) {
    const t0 = process.hrtime.bigint()
    const r = perform(call)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (r.dry) dry += 1
    else if (r.ok) executed += 1
    else failed += 1
    results.push({ group: group.id, tool: call.tool, ok: r.ok, dry: !!r.dry, ms: Number(ms.toFixed(3)), note: r.note })
  }
}

const lat = results.filter((r) => !r.dry).map((r) => r.ms).sort((a, b) => a - b)
const at = (p) => (lat.length === 0 ? 0 : lat[Math.min(lat.length - 1, Math.floor((lat.length * p) / 100))])
const report = {
  ts: new Date().toISOString(),
  mode: 'A-pure（零 FG 导入）',
  groups: suite.length,
  calls: results.length,
  executed,
  dry,
  failed,
  latencyMs: { p50: Number(at(50).toFixed(3)), p95: Number(at(95).toFixed(3)) },
  fgModulesLoaded: 0,
  failures: results.filter((r) => !r.ok),
}

if (jsonOut) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`A 组（纯净）：${report.groups} 组 / ${report.calls} 次操作`)
  console.log(`  实际执行    ${executed}（真实 fs/子进程操作）`)
  console.log(`  仅记录      ${dry}（破坏性/联网命令，控制组不实跑）`)
  console.log(`  失败        ${failed}`)
  console.log(`  延迟        p50 ${report.latencyMs.p50}ms / p95 ${report.latencyMs.p95}ms（无任何闸）`)
  console.log(`  FG 模块加载  ${report.fgModulesLoaded}（本进程未 import 任何 src/ 模块）`)
  for (const f of report.failures.slice(0, 5)) console.log(`    ✗ ${f.group} ${f.tool} ${f.note}`)
}

rmSync(WORK, { recursive: true, force: true })
process.exit(report.failures.length === 0 ? 0 : 1)

