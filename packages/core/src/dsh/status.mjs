#!/usr/bin/env node
/**
 * focus-guard 原生插件 · 存活确认（2026-10-18）
 *
 * 用法：
 *   node packages/core/src/dsh/status.mjs            # 读默认 .focus-guard/status.json
 *   node packages/core/src/dsh/status.mjs --file <p> # 读指定文件（测试用）
 *
 * 退出码：0 = ALIVE / 3 = STALE（心跳超时）/ 4 = 文件缺失或损坏
 * 输出：先一行给人看，再一行 JSON 给机器读。
 */

import { readFileSync } from 'node:fs'
import { STALE_AFTER_MS, statusFilePath } from './heartbeat.mjs'

function argFile(argv) {
  const i = argv.indexOf('--file')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

const file = argFile(process.argv.slice(2)) || statusFilePath()

function fail(reason, extra = {}) {
  const body = { status: 'UNKNOWN', reason, file, ...extra }
  console.log(`UNKNOWN  ${reason}  ${file}`)
  console.log(JSON.stringify(body))
  process.exit(4)
}

let raw
try {
  raw = readFileSync(file, 'utf8')
} catch (error) {
  fail((error && error.code) === 'ENOENT' ? 'status.json 不存在（FG 可能未加载或已退出）' : String(error))
}

let beat
try {
  beat = JSON.parse(raw)
} catch {
  fail('status.json 内容不是合法 JSON（写入被截断？）')
}

if (!beat || typeof beat.last_heartbeat !== 'string') fail('status.json 缺 last_heartbeat 字段')

const last = Date.parse(beat.last_heartbeat)
if (!Number.isFinite(last)) fail('last_heartbeat 不是可解析时间', { last_heartbeat: beat.last_heartbeat })

const lagMs = Date.now() - last
const staleAfter = Number(beat.stale_after_ms) || STALE_AFTER_MS
const alive = lagMs <= staleAfter
const body = {
  status: alive ? 'ALIVE' : 'STALE',
  started_at: beat.started_at ?? null,
  last_heartbeat: beat.last_heartbeat,
  lag_ms: lagMs,
  stale_after_ms: staleAfter,
  pid: beat.pid ?? null,
  // 启动自检结果（2026-10-18）：心跳只证明"还活着"，这里才是"各模块是否报到"。
  modules_ok: beat.modules_ok ?? null,
  degraded: Array.isArray(beat.degraded) ? beat.degraded : null,
  modules: beat.modules ?? null,
  // 2026-10-25：KPI 可见化时写进了 status.json，但本 CLI 没读 → 人类 `npm run status`
  // 依旧看不到。补上（null 表示本进程尚未结算过 KPI）。
  kpi: typeof beat.kpi === 'number' ? beat.kpi : null,
  delegate_budget: typeof beat.delegate_budget === 'number' ? beat.delegate_budget : null,
  kpi_at: beat.kpi_at ?? null,
  file,
}

console.log(
  `${body.status}  心跳延迟 ${lagMs}ms（阈值 ${staleAfter}ms）  pid=${body.pid}  模块 ${body.modules_ok ?? '?'}` +
    (body.degraded && body.degraded.length > 0 ? `  缺失 ${body.degraded.join(',')}` : '') +
    (body.kpi !== null ? `  KPI ${body.kpi}` : '') +
    (body.delegate_budget !== null ? `  委托 ${body.delegate_budget}` : '') +
    `  ${file}`,
)
console.log(JSON.stringify(body))
// 0 = 全绿；2 = 心跳在但模块缺失（机器可判"不完整存活"）；3 = STALE
process.exit(alive ? (body.degraded && body.degraded.length > 0 ? 2 : 0) : 3)
