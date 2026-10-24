/**
 * focus-guard 原生插件 · 压缩监察（2026-10-18）
 *
 * ── 为什么有这一层，而不是"再写一个压缩引擎" ────────────────────────────
 * DSH 0.2 **自带**完整压缩栈，且当前会话就在用：
 *   dsh-compaction（抽象缝 ctx.compaction）
 *   + dsh-compaction-basic（后端，自动触发）
 *   + dsh-command-compact（/compact）
 *   + dsh-compaction-tool-result-pruner（超长工具结果剪枝）
 * 挂载点在 preset 层：dsh-web-app/presets/cordis.patch.yml 的 cordis preset，
 * host 平面则由 dsh-web-app/cordis.patch.yml 显式 disabled（压缩归 preset 所有）。
 *
 * 曾经存在的外部插件 DCR（local-dsh-memory-v09-live-extract）自建了一套压缩，
 * 在 agent/pre-step 上 `agent.cancel` + `{kind:'reject'}`，抢在内置监听器之前把回合
 * 打死在 step 0 —— 这才是 2026-10-18 那串 `CONTEXT_COMPACTION_REQUIRED` 的真根因。
 * 内置阈值约 49k tokens 就触发，DCR 的 HARD 在 98k，内置本可早压。
 *
 * 结论：压缩由 DSH 负责，**FG 只负责监察**。
 * 本模块的三条纪律：
 *   ① 只读事件，绝不写 surface、绝不 append、绝不 cancel —— 它没有能力改变会话；
 *   ② 只用事件里已经带着的事实（compactionId / shadowedSeqs / shadowedTokenCount /
 *      usage.inputTokens / failure.code），**不猜模型上下文窗口**，不设自造阈值；
 *   ③ 全部观察包在 try/catch 里，留痕失败只 warn —— 监察不能成为宿主的新故障点。
 *
 * ── 留痕口径 ───────────────────────────────────────────────────────────
 * 走 audit.mjs 的统一入口 `appendAudit`（JSONL，与 deny / redline-exempt 同文件同格式）。
 * 新增三个 action，纯增量，不改变既有记录的语义：
 *   compaction           一次压缩落定（result: ok | failed）
 *   compaction-anomaly   标记对异常（未闭合的 start / 无主的 end / id 不匹配）
 *   context-overflow     请求撞上下文窗口 —— 这是"该压却没压"的唯一硬证据
 *   compaction-watch-ready / compaction-watch-degraded
 *                        进程级启动自证：本层是否真的挂上了两条缝。
 *                        没有它，AUDIT.log 无法独立回答"监察层在不在"——
 *                        只能靠 status.json 侧面推断，而 status.json 是心跳文件、不是审计台账。
 *                        **同一状态每进程只报一次**；降级↔就位发生翻转时会再报一次（那是真实状态变化）。
 *
 * `compaction/prune`（工具结果剪枝）**不逐条留痕**：它按 8192 字符阈值频繁触发，
 * 逐条写会把审计刷成流水账。改为只累计计数与释放 token，随 compaction / context-overflow
 * 记录一并带出（prunes_so_far / pruned_tokens），既不丢信息也不淹没有效记录。
 */

import { appendAudit } from './audit.mjs'
import { moduleSnapshot, livenessBadge, noteLivenessEvent } from './heartbeat.mjs'
import { statePath, loadState, saveState } from '../core/state.mjs'

const EV_START = 'compaction/start'
const EV_END = 'compaction/end'
const EV_PRUNE = 'compaction/prune'
const EV_USER = 'user/message'
const EV_ASSISTANT = 'assistant/message'

/** 撞窗错误码，取自 @deepseek-ai/dsh-llm（lib/index.js:136 与 lib/types/error.js:22 同值）。 */
export const CONTEXT_OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** 每会话监察状态。WeakMap 以 session 对象为键，会话释放即回收，不泄漏。 */
const states = new WeakMap()

/** 会话标识口径与 audit.mjs::sessionOf 一致：真实 id 在 session.id / session.header.id。 */
function sessionIdOf(session) {
  try {
    const id = session?.id ?? session?.header?.id
    if (typeof id === 'string' && id) return id
  } catch {
    /* header 是惰性 getter，取失败不致命 */
  }
  return 'dsh-native'
}

function stateFor(session) {
  let state = states.get(session)
  if (!state) {
    state = {
      sessionId: sessionIdOf(session),
      open: null, // 未闭合的 compaction/start
      compactions: 0,
      failed: 0,
      anomalies: 0,
      prunes: 0,
      prunedTokens: 0,
      lastInputTokens: 0,
      summary: null, // 本次压缩写下的替换消息（surfaceOp: replace）
      overflowWarned: false,
    }
    states.set(session, state)
  }
  return state
}

/** 供自检 / 测试读取，不参与生产路径。 */
export function _compactionWatchState(session) {
  const state = states.get(session)
  return state ? { ...state, open: state.open ? { ...state.open } : null, summary: state.summary ? { ...state.summary } : null } : null
}

function row(state, action, trigger, extra = {}) {
  return {
    ts: new Date().toISOString(),
    session: state.sessionId,
    action,
    trigger,
    level: null,
    basis: 'builtin:compaction-basic',
    ...extra,
    pardon: false,
  }
}

function clampText(value, max = 300) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 压缩落定留痕。 */
function auditCompaction(state, { failed, durationMs, open, summary, error }) {
  const parts = [
    failed ? 'failed' : 'ok',
    summary ? `${summary.shadowedNodes} 节点 seq ${summary.startSeq}..${summary.endSeq}` : '未观测到替换消息',
    `${durationMs}ms`,
    `输入 ${state.lastInputTokens}`,
  ]
  if (failed) parts.push(`error=${clampText(error, 120)}`)
  // 按需自证（2026-10-19）：压缩是第三个局部点。压缩后模型的上下文被改写过，
  // 这时告诉它"FG 还活着、刚才发生过压缩"才有解释价值；平时不注入。
  noteLivenessEvent(failed ? 'compaction(failed)' : 'compaction')
  // 结果准入额度随压缩恢复（2026-10-24）：压缩后上下文变小，大结果预算理应回满；
  // 恢复失败只留痕，不影响压缩监察本身。
  if (!failed) {
    try {
      const sid = (state.session && state.session.id) || state.sessionId
      if (sid) {
        const file = statePath(sid)
        const st = loadState(file)
        if (st) {
          const def = Number(process.env.FG_RESULT_ADMIT_BUDGET ?? 3)
          saveState(file, { ...st, resultAdmitLeft: Number.isFinite(def) ? def : 3 })
        }
      }
    } catch {
      /* 不阻断 */
    }
  }
  appendAudit(
    row(state, 'compaction', failed ? 'compaction/end(error)' : 'compaction/end', {
      basis: open.sourceCommandId ? 'builtin:command-compact' : 'builtin:compaction-basic',
      result: failed ? 'failed' : 'ok',
      compaction_id: open.compactionId,
      turn: open.turn,
      source_command_id: open.sourceCommandId,
      duration_ms: durationMs,
      shadowed_nodes: summary ? summary.shadowedNodes : null,
      shadowed_range: summary ? `${summary.startSeq}..${summary.endSeq}` : null,
      input_tokens: state.lastInputTokens || null,
      // 剪枝累计：不逐条留痕，但要让它随压缩记录一起可见（"释放了多少"）
      prunes_so_far: state.prunes,
      pruned_tokens: state.prunedTokens,
      liveness: livenessBadge({ drain: false }),
      error: failed ? clampText(error, 300) : null,
      evidence: clampText(parts.join(' | ')),
    }),
  )
}

/** 标记对异常留痕。0.2 用"未匹配的 start"作为 busy 信号，异常本身就是可诊断事实。 */
function auditAnomaly(state, kind, detail) {
  state.anomalies += 1
  appendAudit(
    row(state, 'compaction-anomaly', kind, {
      detail: clampText(detail, 300),
      evidence: clampText(`${kind}: ${detail}`),
    }),
  )
}

/**
 * 观察一条会话事件。
 * 纯函数式副作用：只更新本会话的监察状态并留痕，永不抛、永不改会话。
 */
function observe(session, event) {
  if (!event || typeof event !== 'object') return
  const type = event.type
  if (type !== EV_START && type !== EV_END && type !== EV_PRUNE && type !== EV_USER && type !== EV_ASSISTANT) return

  const state = stateFor(session)
  const data = event.data && typeof event.data === 'object' ? event.data : {}

  if (type === EV_START) {
    if (state.open) {
      auditAnomaly(
        state,
        'unmatched-start',
        `上一次 start（id=${state.open.compactionId ?? '-'} seq=${state.open.seq}）未闭合就开始了 id=${data.compactionId ?? '-'}`,
      )
    }
    state.open = {
      compactionId: data.compactionId ?? null,
      turn: data.turn ?? null,
      // 手动 /compact 会带 sourceCommandId（见 dsh-compaction-basic compactSurfaceRegion），
      // 据此区分"自动压缩"与"人类按需压缩"，审计里可分辨是谁触发的。
      sourceCommandId: data.sourceCommandId ?? null,
      seq: Number(event.seq) || 0,
      at: Number(event.time) || Date.now(),
    }
    state.summary = null
    return
  }

  if (type === EV_USER) {
    // 压缩的摘要以 `user/message` + surfaceOp{op:'replace', startSeq, endSeq} 落在标记对之间。
    const op = event.surfaceOp
    if (state.open && op && typeof op === 'object' && op.op === 'replace') {
      const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
      state.summary = {
        startSeq: op.startSeq ?? null,
        endSeq: op.endSeq ?? null,
        shadowedNodes: sources.length,
      }
    }
    return
  }

  if (type === EV_END) {
    const open = state.open
    state.open = null
    if (!open) {
      auditAnomaly(state, 'orphan-end', `compaction/end（id=${data.compactionId ?? '-'}）没有对应的 start`)
      state.summary = null
      return
    }
    if (open.compactionId && data.compactionId && open.compactionId !== data.compactionId) {
      auditAnomaly(state, 'mismatched-id', `start id=${open.compactionId} 对上了 end id=${data.compactionId}`)
    }
    const failed = data.error !== undefined
    if (failed) state.failed += 1
    else state.compactions += 1
    auditCompaction(state, {
      failed,
      durationMs: Math.max(0, (Number(event.time) || Date.now()) - open.at),
      open,
      summary: state.summary,
      error: data.error,
    })
    state.summary = null
    return
  }

  if (type === EV_PRUNE) {
    state.prunes += 1
    state.prunedTokens += Number(data.shadowedTokenCount) || 0
    return
  }

  // EV_ASSISTANT：记录本次请求的实际输入规模（供应商回报，非估算）
  const input = Number(data?.usage?.inputTokens)
  if (Number.isFinite(input) && input > 0) state.lastInputTokens = input
}

/**
 * `session/event` 监听器工厂（普通事件，非 waterfall）。
 * @param {{ warn: Function }} ctx 由 index.js 的 register() 注入
 */
export function compactionEventListener({ warn } = {}) {
  // warn 缺失时退化为静默：catch 块里再抛一次，等于把监察变成新的 turn 杀手。
  const emit = typeof warn === 'function' ? warn : () => {}
  return (session, event) => {
    try {
      observe(session, event)
    } catch (error) {
      emit('压缩监察观察失败（不阻断会话）:', (error && error.message) || error)
    }
  }
}

/**
 * `agent/request-error` 监听器工厂（**waterfall，必须始终 return next()**）。
 *
 * 撞窗是"该压却没压"的唯一硬证据——它由供应商拒绝给出，不需要 FG 猜任何阈值。
 * 若此时本会话一次压缩、一次剪枝都没发生过，说明压缩栈根本没在干活，必须喊出来。
 * @param {{ warn: Function }} ctx
 */
export function contextOverflowListener({ warn } = {}) {
  const emit = typeof warn === 'function' ? warn : () => {}
  return async ({ agent, failure }, next) => {
    try {
      if (failure && failure.code === CONTEXT_OVERFLOW_CODE) {
        const session = agent && agent.session
        if (session) {
          const state = stateFor(session)
          const dead = state.compactions === 0 && state.prunes === 0
          appendAudit(
            row(state, 'context-overflow', 'agent/request-error', {
              code: failure.code,
              input_tokens: state.lastInputTokens || null,
              compactions_so_far: state.compactions,
              failed_so_far: state.failed,
              prunes_so_far: state.prunes,
              pruned_tokens: state.prunedTokens,
              stack_looks_dead: dead,
              error: clampText(failure.message ?? failure.code, 300),
              evidence: clampText(
                `撞窗 code=${failure.code} 输入=${state.lastInputTokens || '-'} ` +
                  `压缩=${state.compactions} 失败=${state.failed} 剪枝=${state.prunes}(${state.prunedTokens}tok)` +
                  (dead ? ' —— 压缩栈疑似未生效' : ''),
              ),
            }),
          )
          if (dead && !state.overflowWarned) {
            state.overflowWarned = true
            emit(
              `压缩监察：会话 ${state.sessionId} 撞上下文窗口，但本会话 0 次压缩 / 0 次剪枝 —— ` +
                '内置压缩栈疑似未挂载（检查 preset 里的 compaction-basic 行）',
            )
          }
        }
      }
    } catch (error) {
      emit('压缩监察（撞窗）观察失败（不阻断会话）:', (error && error.message) || error)
    }
    // waterfall 纪律：无论观察到什么都必须放行，本模块没有拦截权。
    return typeof next === 'function' ? next() : undefined
  }
}

// ── 启动自证（2026-10-18，人类批示「让日志真正做到自证清白」）────────────────
//
// 病根：上面所有记录都是**被动**的——只有会话真的压过一次，AUDIT.log 里才有 `compaction`。
// 于是"监察层没挂上"和"挂上了但还没触发"在日志里长得一模一样，都表现为"什么都没有"。
// 唯一旁证是 `.focus-guard/status.json`，但那是心跳文件、随时被覆写，而且它证明的是
// "插件在跳"，不是"这两条缝在听"。要把两者分开，只能在进程启动时无条件留一条。
//
// 口径：**同一状态每进程只报一次**（`announced` 闸门）；ready↔degraded 真发生翻转时再报一次
// ——那不是重复，是真实的状态变化，必须留痕。翻转在当前装配流程里理论上不会发生
// （register() 在 apply() 内同步跑完），闸门是防御性的，不是功能。

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
