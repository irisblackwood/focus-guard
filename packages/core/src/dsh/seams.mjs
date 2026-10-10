/**
 * focus-guard 原生插件 · 补充宿主缝（3.0.8 · 孤儿机制移植第一步）
 *
 * 背景：原生插件原本只注册了 pipeline.mjs 的三条缝（tools/pre-execute、system-prompt/assemble、
 * tools/post-execute），而 guard.mjs 的六条缝里另有三条在 DSH 侧没有对应实现——于是
 * KPI / 三预算池 / 审批单 / 抽查 / 污染检测 / 因果链 / 图书馆 / 降级 / 绝境等机制
 * 全都停在 guard.mjs（封存且未挂载）里，DSH 用户拿不到。
 *
 * 本文件按官方桥（@deepseek-ai/dsh-hooks-claude-code）已验证的事件映射，把缺的三条缝接上：
 *   SessionStart      ← agent/created       （本文件 sessionStartListener）
 *   UserPromptSubmit  ← agent/pre-step      （waterfall，必须 return next()）
 *   Stop              ← agent/turn-stopping （KPI 兑现结算落在这里）
 * 映射来源是桥的实测代码，不是猜测（见侧栏注释）。
 *
 * 纪律：本文件所有写入经 appendAudit / saveState / saveLedger，均已有 fail-open 与留痕；
 * 任一缝异常只 warn，绝不断开 DSH 主流程。
 */
import { existsSync } from 'node:fs'
import { statePath, loadState, saveState, saveLedger } from '../core/state.mjs'
import { BUDGET_CAP, DELEGATE_DEFAULT } from '../core/constants.mjs'
import { appendAudit } from './audit.mjs'

/**
 * 从 DSH 的 agent 对象取会话标识。
 * 入参形状与 pipeline 的 exec 不同（这里是 { agent } 而非 exec），故单独取值；
 * 取值顺序：agent.session.id（DSH 的会话主键）→ agent.sessionId → agent.id。
 */
function sidOf(agent) {
  return (agent && ((agent.session && agent.session.id) || agent.sessionId || agent.id)) || 'dsh-native'
}

/** 卷宗落点：DSH 的工作目录即项目根。 */
const projDirOf = () => process.cwd()

/** 载入本会话状态；文件不存在时 loadState 返回默认结构（含 readSet: {}）。 */
function loadOrInit(agent) {
  const sid = sidOf(agent)
  const file = statePath(sid)
  return { sid, file, state: loadState(file) }
}

/** 写一条审计（DSH 侧统一入口，带体积轮转）。 */
function auditRow(sid, action, evidence) {
  appendAudit({
    ts: new Date().toISOString(),
    session: sid,
    seq: Date.now().toString(36) + '.' + Math.floor(performance.now()),
    action,
    trigger: action,
    level: null,
    evidence: String(evidence || '').slice(0, 200),
  })
}

/**
 * ① agent/created → SessionStart：建立/载入本会话状态。
 * 这是"原生插件自持状态"的起点——此前 DSH 侧没有任何 state 写入者，
 * 所有依赖 state 的机制（取证、KPI、预算池…）因此一起失效。
 */
export function sessionStartListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      if (!existsSync(file)) {
        saveState(file, state)
        auditRow(sid, 'start-fired', `本会话状态初始化（DSH 原生插件自持）：${file}`)
      }
    } catch (error) {
      if (typeof warn === 'function') warn('会话启动缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}

/**
 * ② agent/pre-step → UserPromptSubmit：回合级重置（waterfall 缝，必须 return next()）。
 * 对应 guard.mjs 的 reset 模式：回合计数归零、清回合级标记。
 * 注：人类批示识别（额度和授权）依赖批示文本与预算体系，留待后续步骤——本步只接缝。
 */
export function preStepListener({ warn } = {}) {
  return async ({ agent } = {}, next) => {
    try {
      const { file, state } = loadOrInit(agent)
      state.turnCount = 0
      state.stopBlocked = false
      state.highRiskDeniedThisTurn = false
      saveState(file, state)
    } catch (error) {
      if (typeof warn === 'function') warn('回合重置缝异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}

/**
 * ③ agent/turn-stopping → Stop：KPI 兑现结算（二十七~三十二条部分机械化）。
 * 逻辑照搬 guard.mjs 的 stop 分支以保行为一致：本任务 KPI → 等次 → 委托池奖惩，
 * 跨任务累计入 kpiCarry。执行池增减仍由人类批示，引擎只动委托池。
 *
 * ⚠ 与 guard.mjs 的差异（有意的）：这里**不**做 saveState 之外的收尾动作
 *（如回合计数、额度台账以外的判定），只落 KPI 结算 —— 逐步移植，避免一次搬太多。
 */
export function turnStoppingListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      const kpiNow = state.kpi || 0
      let grade = '称职'
      let poolDelta = 0
      if (kpiNow >= 15) {
        grade = '优秀'
        poolDelta = 5
      } else if (kpiNow >= 0) {
        grade = '称职'
        poolDelta = 0
      } else if (kpiNow >= -9) {
        grade = '基本称职'
        poolDelta = -2
      } else {
        grade = '不称职'
        poolDelta = -5
      }
      state.delegateBudget = Math.max(
        0,
        Math.min(BUDGET_CAP, (state.delegateBudget ?? DELEGATE_DEFAULT) + poolDelta),
      )
      state.kpiCarry = (state.kpiCarry || 0) + kpiNow
      if (kpiNow <= -10) {
        if (!state.kpiLowReported) {
          state.kpiLowReported = true
          auditRow(sid, 'kpi-low', `委派 KPI ${kpiNow}：强制委派场景累计失分，下任务请优先 Agent 委派（委托池独立 20 次）`)
        }
      } else if (state.kpiLowReported) {
        state.kpiLowReported = false // KPI 回升到阈值以上后，再次跌破可重新提醒
      }
      saveState(file, state)
      saveLedger(projDirOf(), state)
      auditRow(
        sid,
        'kpi-settle',
        `二十七~三十二条 兑现 KPI=${kpiNow} 等次=${grade} 委托池${poolDelta >= 0 ? '+' : ''}${poolDelta}（现=${state.delegateBudget}）跨任务累计=${state.kpiCarry}`,
      )
    } catch (error) {
      if (typeof warn === 'function') warn('KPI 结算缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}
