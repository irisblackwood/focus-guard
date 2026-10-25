/**
 * focus-guard 原生插件 · 审计位置元数据（turn / step）—— 2026-10-19 人类批示
 *
 * 为什么需要：AUDIT.log 原来只有 `seq`（进程内单调序号，跨会话不可比），
 * 于是"熔断后到底浪费了几步"算不出来 —— `stalledFuse.threshold` 该松该紧无从判断（ARCH-MAP 缺口 #3）。
 *
 * 位置数据从哪来（这是唯一来源，不是猜的）：
 *   宿主 `agent/pre-step` 的载荷是 `{ messages, turn, step, signal }`
 *   （`@deepseek-ai/dsh-agent-loop/lib/index.js:956-959` 传 `{ turn, step }`），
 *   而 `tools/pre-execute` 的 exec 只有 `{ token, callId, rootCallId, name, signal, agent, parent, schema, arguments }`
 *   （`@deepseek-ai/dsh-tools/lib/index.js:3239-3264`）——**没有** turn/step。
 *   所以位置只能由 pre-step 缝记录，再由 `core/audit-writer.mjs` 的 provider 钩子统一注入到每条审计行。
 *
 * 语义（写死，别改口径）：
 *   - `turn`：回合号，宿主从 1 递增；每回合重置 step。
 *   - `step`：回合内步号，宿主从 1 递增。
 *   - 熔断点：本回合第一次写 `stall-fuse` 时的 (turn, step)。
 *   - 熔断浪费 `wastedSteps` = 同回合结束时 step − 熔断点 step（被拦的步也算一步；deny 另有行可查）。
 *   - **按会话独立计数**：每个会话的 step 从 1 重新开始，跨会话不可相加。
 *
 * 落盘：回合结束时由 `recordFuseWaste()` 写一行 `action:"fuse-waste"`（**只在真熔断过的回合**写，不是每步一行）。
 */
import { appendAudit, setTraceMetaProvider } from '../core/audit-writer.mjs'

/** sid → { turn, step, fuseTurn, fuseStep } */
const sessions = new Map()

/** 会话键：接受 agent 对象或 session id 字符串。 */
function keyOf(agentOrSession) {
  if (typeof agentOrSession === 'string') return agentOrSession || 'dsh-native'
  const agent = agentOrSession
  return (
    (agent &&
      ((agent.session && agent.session.header && agent.session.header.id) ||
        agent.sessionId ||
        agent.id)) ||
    'dsh-native'
  )
}

/**
 * 记录一步的位置。只在 pre-step 缝调用。
 * 换回合（turn 变化）时作废上一回合的熔断点——熔断语义是"本回合内"。
 * @returns {{turn:number, step:number}|null} 当前位置（入参非法时为原值或 null）
 */
export function noteTracePosition(agentOrSession, turn, step) {
  const key = keyOf(agentOrSession)
  const t = Number(turn)
  const s = Number(step)
  if (!Number.isInteger(t) || !Number.isInteger(s) || t < 0 || s < 0) return sessions.get(key) || null
  const prev = sessions.get(key)
  if (!prev || prev.turn !== t) {
    sessions.set(key, { turn: t, step: s, fuseTurn: null, fuseStep: null })
  } else {
    prev.step = s
  }
  return { turn: t, step: s }
}

/** 当前位置（只读探测，测试用）。 */
export function currentPosition(agentOrSession) {
  const pos = sessions.get(keyOf(agentOrSession))
  return pos ? { turn: pos.turn, step: pos.step, fuseTurn: pos.fuseTurn, fuseStep: pos.fuseStep } : null
}

/**
 * provider 实现：给审计行补 turn/step；顺带在遇到 `stall-fuse` 行时钉住熔断点。
 * 有副作用是刻意的——所有 stall-fuse 写点（seams / postProgress / stopGuard）都经 appendAudit，
 * 在写入器这一处识别比逐个改调用点更不容易漏。
 */
function traceMetaOf(session, row) {
  const key = String(session || 'dsh-native')
  const pos = sessions.get(key)
  if (!pos) return null
  if (row && row.action === 'stall-fuse' && pos.fuseTurn === null) {
    pos.fuseTurn = pos.turn
    pos.fuseStep = pos.step
  }
  return { turn: pos.turn, step: pos.step }
}

/**
 * 回合结束结算：本回合真熔断过才写一行 `fuse-waste`。
 * 由 `agent/turn-stopping` 调用（index.js 的 turn-stopping 包装里）。
 * @returns {{session:string, turn:number, fuseStep:number, lastStep:number, wastedSteps:number}|null}
 */
export function recordFuseWaste(agentOrSession) {
  const key = keyOf(agentOrSession)
  const pos = sessions.get(key)
  if (!pos || pos.fuseTurn === null) return null
  const report = {
    session: key,
    turn: pos.fuseTurn,
    fuseStep: pos.fuseStep,
    lastStep: pos.step,
    wastedSteps: Math.max(0, pos.step - pos.fuseStep),
  }
  pos.fuseTurn = null
  pos.fuseStep = null
  try {
    appendAudit({
      ts: new Date().toISOString(),
      session: key,
      action: 'fuse-waste',
      turn: report.turn,
      step: report.fuseStep,
      wasted: report.wastedSteps,
      evidence: `熔断后步数=${report.wastedSteps}（熔断 step ${report.fuseStep} → 回合末 step ${report.lastStep}）`,
      pardon: false,
    })
  } catch {
    /* fail-open：结算是可观测性，不阻断回合 */
  }
  return report
}

/** 装上 provider（插件 apply 时调用一次）。返回卸载函数。 */
export function installTraceMeta() {
  setTraceMetaProvider(traceMetaOf)
  return () => setTraceMetaProvider(null)
}

/** 清空内存并卸载 provider（仅测试用）。 */
export function resetTraceMeta() {
  sessions.clear()
  setTraceMetaProvider(null)
}
