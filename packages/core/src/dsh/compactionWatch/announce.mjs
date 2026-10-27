/**
 * 压缩监察 · 启动自证（2026-10-27 从 compactionWatch.mjs 抽出，纯搬运）。
 *
 * 病根：监察记录都是**被动**的——只有会话真的压过一次，AUDIT.log 里才有 `compaction`。
 * 于是"监察层没挂上"和"挂上了但还没触发"在日志里长得一模一样，都表现为"什么都没有"。
 * 唯一旁证是 `.focus-guard/status.json`，但那是心跳文件、随时被覆写，而且它证明的是
 * "插件在跳"，不是"这两条缝在听"。要把两者分开，只能在进程启动时无条件留一条。
 *
 * 口径：**同一状态每进程只报一次**（`announced` 闸门）；ready↔degraded 真发生翻转时再报一次
 * ——那不是重复，是真实的状态变化，必须留痕。翻转在当前装配流程里理论上不会发生
 * （register() 在 apply() 内同步跑完），闸门是防御性的，不是功能。
 */
import { appendAudit } from '../audit.mjs'
import { moduleSnapshot } from '../heartbeat.mjs'

/** 日志字段截断：超长详情只留前 `max` 字。 */
export function clampText(value, max = 300) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 本层依赖的两条宿主缝；label 必须与 index.js 里 register() 的第三参数逐字一致。 */
export const WATCH_SEAMS = ['session/event(compaction-watch)', 'agent/request-error(compaction-watch)']

/** 进程启动时刻：只用于让"这条记录属于哪一次启动"可核对，不参与任何判断。 */
const PROCESS_STARTED_AT = new Date().toISOString()

/** @type {'ready'|'degraded'|null} 上一次宣告的状态；null = 本进程尚未宣告。 */
let announced = null

/** 测试钩子：清空宣告闸门，使同一进程内可重复验证。生产路径不调用。 */
export function _resetWatchAnnounce() {
  announced = null
}

/**
 * 读当前装配快照，判定本层是否真的挂上了两条缝。
 * 数据源是 heartbeat.mjs 的 MODULES —— register() 成功即 markModule(label, true)，
 * 这是"注册到底成没成"的唯一权威口径，比任何自检代码更可信。
 * @returns {{ ready: boolean, seams: Record<string,string>, bad: string[], ok: number, total: number, degraded: string[] }}
 */
function seamSnapshot() {
  const snapshot = moduleSnapshot()
  const seams = {}
  const bad = []
  for (const key of WATCH_SEAMS) {
    // 未出现在快照里 = apply() 根本没跑到那行 register()，与 FAIL 同等对待。
    const value = snapshot[key] === undefined ? 'MISSING: 未报到' : snapshot[key]
    seams[key] = value
    if (value !== 'OK') bad.push(`${key}=${value}`)
  }
  const keys = Object.keys(snapshot)
  return {
    ready: bad.length === 0,
    seams,
    bad,
    ok: keys.filter((k) => snapshot[k] === 'OK').length,
    total: keys.length,
    // 全量降级清单：自证行要能独立说明"整机几成"，而不只是本层两条缝。
    degraded: keys.filter((k) => snapshot[k] !== 'OK'),
  }
}

/**
 * 启动自证：把"监察层在不在"无条件写进 AUDIT.log 一次。
 *
 * 必须在 index.js 的两条 register() **与**心跳启动**之后**调用 ——
 * 自证要反映的是最终装配结果，早一步调用就会漏掉心跳、报出错误的完成度。
 *
 * 永不抛：写不进去只 warn。自证失败不能变成宿主的新故障点（与本层其余部分同纪律）。
 * @param {{ warn?: Function }} [options]
 * @returns {'ready'|'degraded'|null} 本次宣告的状态；被闸门拦下时返回上次的状态
 */
export function announceWatchReady({ warn } = {}) {
  const emit = typeof warn === 'function' ? warn : () => {}
  try {
    const { ready, seams, bad, ok, total, degraded } = seamSnapshot()
    const next = ready ? 'ready' : 'degraded'
    if (announced === next) return next
    announced = next

    const action = ready ? 'compaction-watch-ready' : 'compaction-watch-degraded'
    const evidence = ready
      ? `监察层就位：${WATCH_SEAMS.length} 条缝均已注册，压缩事件与撞窗告警都会进本日志` +
        `（模块 ${ok}/${total} 报到，pid ${process.pid}）`
      : `监察层未就位：${bad.join('；')} —— 该缝未注册时，对应的压缩事件不会进本日志` +
        `（模块 ${ok}/${total} 报到，pid ${process.pid}）`

    appendAudit({
      ts: new Date().toISOString(),
      // 进程级记录没有会话归属，用既有兜底口径 dsh-native，另以 scope 标明不是会话级留痕。
      session: 'dsh-native',
      action,
      trigger: 'startup',
      level: null,
      basis: 'fg:compaction-watch',
      scope: 'process',
      pid: process.pid,
      process_started_at: PROCESS_STARTED_AT,
      watching: [...WATCH_SEAMS],
      seams,
      modules_ok: `${ok}/${total}`,
      degraded_modules: degraded,
      readonly: true,
      evidence: clampText(evidence),
      pardon: false,
    })

    if (!ready) {
      emit(`压缩监察层未就位：${bad.join('；')} —— 这些缝未注册时，压缩事件不会进 AUDIT.log`)
    }
    return next
  } catch (error) {
    emit('压缩监察启动自证失败（不影响会话）:', (error && error.message) || error)
    return null
  }
}
