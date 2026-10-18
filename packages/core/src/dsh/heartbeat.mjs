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
 * 模型侧告警文本；全部报到时返回 null（正常路径零注入）。
 * 只在真的缺模块时占用系统提示 token。
 */
export function livenessNote() {
  const bad = degradedModules()
  if (bad.length === 0) return null
  const detail = bad.map((id) => `${id}（${MODULES.get(id)?.error ?? '未报到'}）`).join('；')
  return (
    `[FG-DEGRADED] FocusGuard 启动自检：${MODULES.size - bad.length}/${MODULES.size} 个模块报到，` +
    `缺失 ${bad.length} 个 —— ${detail}。` +
    '这些缝的执法能力当前不可用，不要假设它们仍在拦；收尾时提示人类重启 DSH。'
  )
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
