/**
 * focus-guard 原生插件 · 心跳（2026-10-18）
 *
 * 目的只有一个：**宿主外**能判断 FG 还在不在跑。插件挂掉/被炸/卡死时，
 * 文件不再更新，读文件的人立刻看得出来。
 *
 * 设计（与最初序列图一致，但去掉常驻 watchdog 进程）：
 *   · 插件内定时器每 10s 原子覆写 `<仓库根>/.focus-guard/status.json`；
 *   · 确认是按需的：`node src/dsh/status.mjs` 读文件算 lag，超 30s 判 STALE。
 *
 * 为什么不在插件里再跑一个轮询器：同进程的轮询器无法发现"本进程已死"，
 * 只能发现"没在写"，等价于读文件本身。真 watchdog 必须是外部进程。
 *
 * 纪律：写入失败只 warn 一次，绝不抛出——心跳不能成为宿主的新故障点。
 * 路径：与 AUDIT.log 同目录（`audit.mjs` 同一套 `../../../../` 上溯规则），
 *      `FG_STATUS_FILE` 可重定向（测试必须用它，否则写进真实工作区）。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 心跳周期；`FG_HEARTBEAT_INTERVAL_MS` 可覆盖（测试用）。 */
export const HEARTBEAT_INTERVAL_MS = Number(process.env.FG_HEARTBEAT_INTERVAL_MS) || 10_000

/** 超过该时长未更新即判 STALE；`FG_STALE_AFTER_MS` 可覆盖（测试用）。 */
export const STALE_AFTER_MS = Number(process.env.FG_STALE_AFTER_MS) || 30_000

/** 插件文件位于 <仓库根>/packages/core/src/dsh/ → 上溯 4 级到仓库根。 */
export const STATUS_FILE = fileURLToPath(new URL('../../../../.focus-guard/status.json', import.meta.url))

/** 心跳文件路径；与 `auditFilePath()` 同思路。 */
export function statusFilePath() {
  return process.env.FG_STATUS_FILE || STATUS_FILE
}

// ── 启动自检：各执法模块报到表（2026-10-18，人类批示「哪个模块没报告就喊」）──
// 语义只有一条：`apply()` 里每个 `register()` 成功即报到，抛错即失败。
// 未报到的模块＝该执法缝**可能没生效**，不能在降级状态下假装它在执法。

/** @type {Map<string, { ok: boolean, error?: string, at: string }>} */
const MODULES = new Map()

/** 登记一个模块的启动结果。 */
export function markModule(id, ok, error) {
  MODULES.set(id, {
    ok: ok === true,
    ...(ok === true ? {} : { error: error === undefined ? '未报到' : String(error) }),
    at: new Date().toISOString(),
  })
}

/** 当前报到快照：{ 'id': 'OK' | 'FAIL: <msg>' }。 */
export function moduleSnapshot() {
  const out = {}
  for (const [id, row] of MODULES) out[id] = row.ok ? 'OK' : `FAIL: ${row.error ?? '未报到'}`
  return out
}

/** 未报到的模块 id 列表。 */
export function degradedModules() {
  return [...MODULES.entries()].filter(([, row]) => !row.ok).map(([id]) => id)
}

/**
 * 模型侧告警文本（**已停用**）。
 *
 * 2026-10-19「按需自证（Lazy Liveness）」：存活状态不再作为系统提示的一部分注入。
 * 原因：常驻注入既占 token 又稀释注意力，而"模块是否活着"只在**需要解释一次拦截**时才有意义。
 * 现改由 `livenessBadge()` 在拦截 / fg_apply / 压缩事件这三个局部点附带。保留本函数仅为兼容，
 * 新代码请勿调用。
 */
export function livenessNote() {
  return livenessBadge({ full: true })
}

// ── 按需自证：局部徽标 ──
// 设计三条：
//   ① 心跳继续后台写 status.json，但**不进 Prompt**；
//   ② 徽标只在"模型需要知道 FG 是否在场"的三个点出现：拦截（deny/ask）、fg_apply 结果、压缩事件后首次交互；
//   ③ 徽标读取后即清空待报告事件（一次性），避免长期携带同一句噪音。
let pendingEvent = null

/** 记录一个需要在下一次局部输出里报告的生存相关事件（如 compaction）。 */
export function noteLivenessEvent(kind) {
  pendingEvent = String(kind || 'event')
  return pendingEvent
}

// 2006-10-22：KPI 快照（人类反馈"KPI 感觉不到"）。
// KPI 本身不参与任何判定（全仓只有写入与结算），所以唯一能"看见"的时机是 FG 说话的三个局部点：
// 拦截理由 / fg_apply 结果 / 压缩事件——也就是 livenessBadge 出现的地方。这里只做展示，不改行为。
let kpiSnapshot = null

/** 由收尾结算处调用（seams.mjs / guard.mjs），记录本会话 KPI 与委托池余量。 */
export function setKpiSnapshot(snap) {
  if (!snap) {
    kpiSnapshot = null
    return
  }
  const kpi = Number(snap.kpi)
  const del = Number(snap.delegateBudget)
  kpiSnapshot = {
    kpi: Number.isFinite(kpi) ? kpi : null,
    delegateBudget: Number.isFinite(del) ? del : null,
    at: new Date().toISOString(),
  }
}

/** 供 status.json 与徽标共用的一份快照（无则 null）。 */
export function kpiTag() {
  if (!kpiSnapshot) return ''
  const parts = []
  if (kpiSnapshot.kpi !== null) parts.push(`KPI ${kpiSnapshot.kpi > 0 ? '+' : ''}${kpiSnapshot.kpi}`)
  if (kpiSnapshot.delegateBudget !== null) parts.push(`委托 ${kpiSnapshot.delegateBudget}`)
  return parts.length ? `；${parts.join(' · ')}` : ''
}

/**
 * 生成一次性存活徽标。正常时极短（`[FG 存活 15/15]`），异常时带降级模块名。
 * @param {{ full?: boolean, drain?: boolean }} [opts] full=true 返回冗长版；drain=false 不消费待报告事件
 */
export function livenessBadge(opts = {}) {
  const drain = opts.drain !== false
  const bad = degradedModules()
  const ok = MODULES.size - bad.length
  const degradedPart = bad.length ? `；降级: ${bad.join(',')}` : ''
  const persistPart = opts.full && bad.length ? '。这些缝的执法能力当前不可用，不要假设它们仍在拦；收尾时提示人类重启 DSH' : ''
  const eventPart = pendingEvent ? `；事件: ${pendingEvent}` : ''
  const kpiPart = kpiTag()
  if (drain) pendingEvent = null
  return `[FG 存活 ${ok}/${MODULES.size}${degradedPart}${eventPart}${kpiPart}${persistPart}]`
}

/**
 * 启动心跳：立即写一次，然后按周期覆写。返回停止函数。
 * @param {{ warn?: (...parts: unknown[]) => void }} [options]
 * @returns {() => void} 停止心跳
 */
export function startHeartbeat({ warn } = {}) {
  const file = statusFilePath()
  const startedAt = new Date().toISOString()
  let warned = false

  const beat = () => {
    const body = {
      status: 'ALIVE',
      started_at: startedAt,
      last_heartbeat: new Date().toISOString(),
      pid: process.pid,
      interval_ms: HEARTBEAT_INTERVAL_MS,
      stale_after_ms: STALE_AFTER_MS,
      // 启动自检结果随心跳一起对外：读文件的进程能同时看到「还在跳」和「哪些模块没报到」。
      modules_ok: `${MODULES.size - degradedModules().length}/${MODULES.size}`,
      degraded: degradedModules(),
      modules: moduleSnapshot(),
      // 2026-10-22：KPI 快照对外可见（status.mjs / 人类排查都能读），不参与判定。
      kpi: kpiSnapshot ? kpiSnapshot.kpi : null,
      delegate_budget: kpiSnapshot ? kpiSnapshot.delegateBudget : null,
      kpi_at: kpiSnapshot ? kpiSnapshot.at : null,
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      // 先写临时文件再 rename：外部读到的永远是完整 JSON，不会是写了一半的截断内容。
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(body)}\n`)
      renameSync(tmp, file)
      warned = false
    } catch (error) {
      if (!warned) {
        warned = true
        warn?.('心跳写入失败（不阻断宿主）:', (error && error.message) || error)
      }
    }
  }

  // 首次写放到下一 tick：`startHeartbeat` 是自己也是最后一个报到模块，
  // 同步写会让首帧快照少它一个（10/10 而不是 11/11），外面看到的就是错的完成度。
  const kick = setTimeout(beat, 0)
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  // 心跳不该拖住宿主退出：unref 后它不参与事件循环引用计数。
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    clearTimeout(kick)
    clearInterval(timer)
  }
}
