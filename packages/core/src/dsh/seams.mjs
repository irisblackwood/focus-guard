/**
 * focus-guard 原生插件 · 补充宿主缝（3.0.8 · 孤儿机制移植）
 *
 * 背景：原生插件原本只注册 pipeline.mjs 的三条缝（tools/pre-execute、system-prompt/assemble、
 * tools/post-execute），而 guard.mjs 的六条缝里另有三条在 DSH 侧没有对应实现——于是
 * KPI / 三预算池 / 审批单 / 抽查 / 污染检测 / 因果链 / 图书馆 / 降级 / 绝境等机制
 * 全都停在 guard.mjs（封存且未挂载）里，DSH 用户拿不到。
 *
 * 本文件按官方桥（@deepseek-ai/dsh-hooks-claude-code）已验证的事件映射接上缺失的缝：
 *   SessionStart      ← agent/created       （sessionStartListener）
 *   UserPromptSubmit  ← agent/pre-step      （preStepListener · waterfall，必须 return next()）
 *   Stop              ← agent/turn-stopping （turnStoppingListener · KPI 兑现结算）
 *
 * 取值口径与桥一致（lib/index.js:349-354）——**这不是可选项**：
 *   sid = agent.session.header.id   ← 用 agent.session.id 会取不到，于是全部会话退化成同一个
 *                                      'dsh-native'，造成跨会话状态污染。
 *   cwd = agent.session.header.cwd ?? process.cwd()
 *   人类文本 = messages.flatMap(m => m.content).filter(b => b.type==='text').map(b => b.text).join('')
 *
 * 纪律：所有写入经 appendAudit / saveState / saveLedger（均 fail-open + 留痕）；
 * 任一缝异常只 warn，绝不断开 DSH 主流程。
 */
import { existsSync } from 'node:fs'
import { statePath, loadState, saveState, saveLedger } from '../core/state.mjs'
import {
  BUDGET_CAP,
  BUDGET_DEFAULT,
  CREDIT_RE,
  DELEGATE_DEFAULT,
  INV_POOL_DEFAULT,
  KEY15_RE,
  KEY50_RE,
  MERCY_RE,
  MERCY_SHORT,
  REFILL,
  STOP_ORDER_RE,
} from '../core/constants.mjs'
import { appendAudit } from './audit.mjs'

/** 会话标识：与桥同源（agent.session.header.id）。取不到才退化为 dsh-native。 */
function sidOf(agent) {
  return (
    (agent && ((agent.session && agent.session.header && agent.session.header.id) || agent.sessionId || agent.id)) ||
    'dsh-native'
  )
}

/** 工作目录：与桥同源（session.header.cwd），缺省用进程 cwd。 */
function projDirOf(agent) {
  return (agent && agent.session && agent.session.header && agent.session.header.cwd) || process.cwd()
}

/** 从 agent/pre-step 的 messages 提取人类提示原文（与桥的 blocksToText 同口径）。 */
function humanTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  const blocks = messages.flatMap((m) => (m && Array.isArray(m.content) ? m.content : []))
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('')
}

/** 载入本会话状态；文件不存在时 loadState 返回默认结构（含 readSet: {}）。 */
function loadOrInit(agent) {
  const sid = sidOf(agent)
  const file = statePath(sid)
  return { sid, file, state: loadState(file) }
}

/** 写一条审计（DSH 侧统一入口，带体积轮转）。 */
function auditRow(sid, action, evidence, extra = {}) {
  appendAudit({
    ts: new Date().toISOString(),
    session: sid,
    seq: Date.now().toString(36) + '.' + Math.floor(performance.now()),
    action,
    trigger: action,
    level: extra.level ?? null,
    evidence: String(evidence || '').slice(0, 200),
    pardon: !!extra.pardon,
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

// ── 3.0.8 修法：审批单机制退役 ──
// 原 guard.mjs 的 reset 段含 y/n 批示识别（Y_TOKEN/N_TOKEN/LEAD/TAIL）与待批队列处理，
// 本文件批 1 曾照搬。**现已移除**——理由（人类批示 2026-10-10）：
//   审批单只需敲一个 y，**无目的、无范围、无留档**；而 fg_apply 要求 purpose/scope 结构化留档。
//   两套并存时人会本能选省事的那条，使"事前结构化申请"形同虚设。
//   **留一条能绕过主设计的旁路，等于没有主设计。**
// 误伤救济（fg_appeal）不受影响：它不是绕过，而是申辩——须附反例锚点、人类一次性裁决、全程留痕。
// 对应条文修法见 RULES 第七十五条(三)(四)。

/**
 * ② agent/pre-step → UserPromptSubmit：回合重置（waterfall，必须 return next()）。
 *
 * 移植自 guard.mjs 的 reset 模式（L194-326），但**不含**已退役的审批单部分（y/n 批示识别与待批队列）。
 * 去掉脚本特有部分：process.exit / detectEnv 环境重检（依赖 env.mjs 探测链，留待后续批次）。
 */
export function preStepListener({ warn } = {}) {
  return async ({ agent, messages } = {}, next) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      const promptText = humanTextOf(messages)
      const short = promptText.trim()

      // 特赦识别
      const grant = promptText.match(MERCY_RE)
      const mercy = !!(grant && short.length <= MERCY_SHORT)
      if (mercy) auditRow(sid, 'mercy-granted', `批示原文: ${grant[0]}`, { pardon: true })

      // 目标预授权与执行级授权分离：任务指令里的「上传/推送」只记 goal，不解锁执行标记
      const goalPush =
        /上传|推送|push/i.test(promptText) && !/(不|禁|勿|别|暂|缓)[^，。；\n]{0,6}(上传|推送|push)/i.test(promptText)
      if (goalPush) auditRow(sid, 'goal-preauth', 'goal=push-at-end（目标预授权，不构成执行级授权）')

      // 信用延期：连续停滞 ≥2 且收到信用批示 → 侦查池/执行池各补一次
      let creditGranted = false
      if (short.length <= 12 && (state.stalledStreak || 0) >= 2 && CREDIT_RE.test(short)) {
        state.stalledStreak = 0
        state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP)
        state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP)
        state.invWarned = false
        creditGranted = true
      }

      // 停止令：人类明确批示停止 → 熔断（旧实现曾在本函数后续把 fused 硬写回 false，止停令被自己抹掉）
      const stopOrdered = short.length <= 12 && STOP_ORDER_RE.test(short)
      if (stopOrdered) {
        state.fused = true
        state.violations = Math.max(state.violations || 0, 3)
        auditRow(sid, 'stall-fuse', '人类批示停止', { level: 3 })
      }

      // 24条(三) 追加批示：三池各 +REFILL
      if (short.length <= 12 && /追加|增加额度|扩大额度/.test(short)) {
        state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP)
        state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP)
        state.invWarned = false
        state.delegateBudget = Math.min((state.delegateBudget ?? DELEGATE_DEFAULT) + REFILL, BUDGET_CAP)
        auditRow(
          sid,
          'budget-extend',
          `24条(三) 追加批示 budget=${state.taskBudget} invCap=${state.invCap} delegate=${state.delegateBudget}`,
        )
      }

      // 43条 状态重置核验：上一回合残留 → 记档后清理
      const residues = []
      if ((state.turnCount || 0) > 0) residues.push(`turnCount=${state.turnCount}`)
      if ((state.stalledStreak || 0) > 0) residues.push(`stall=${state.stalledStreak}`)
      if (state.fused && !stopOrdered) residues.push('fused')
      if (state.forcedInvestigate) residues.push('forcedInvestigate')
      if (state.stopBlocked) residues.push('stopBlocked')
      if (state.readSet && Object.keys(state.readSet).length)
        residues.push(`readSet=${Object.keys(state.readSet).length}`)
      if (residues.length) auditRow(sid, 'residue-check', `43条 残留(已清理): ${residues.join(' ')}`)

      // 额度核定
      const kw = KEY50_RE.test(promptText) ? 50 : KEY15_RE.test(promptText) ? 15 : BUDGET_DEFAULT
      state.taskBudget = Math.max(kw, state.declaredBudget || 0, state.taskBudget || BUDGET_DEFAULT)
      state.taskInitial = state.taskBudget
      state.ineffCalls = 0
      const chain = 'T' + Date.now().toString(36)

      saveState(file, {
        ...state, // envCache/caseCache（侦查缓存）随 spread 保留；kpi/delegateUsed 跨回合保留
        turnCount: 0,
        fused: stopOrdered,
        stopBlocked: false,
        mercy,
        goalPush,
        violations: stopOrdered ? Math.max(state.violations || 0, 3) : 0,
        forcedInvestigate: false,
        probation: false,
        readSet: {},
        delegated: false,
        editedFiles: {},
        kpiScolded: {},
        kpiDelegatedAwarded: false,
        turnPrompt: promptText.slice(0, 500),
        turnPromptFull: promptText.slice(0, 4000),
        taskBudget: state.taskBudget,
        taskInitial: state.taskInitial,
        taskChain: chain,
        lastSig: '',
        lastInput: '',
      })

      auditRow(
        sid,
        'reset-fired',
        `prompt:${promptText ? '有' : '无'} kw=${kw} budget=${state.taskBudget} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} stall=${state.stalledStreak || 0}${creditGranted ? ' 信用延期' : ''}${mercy ? ' 特赦' : ''}`,
      )
    } catch (error) {
      if (typeof warn === 'function') warn('回合重置缝异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}

/**
 * ③ agent/turn-stopping → Stop：KPI 兑现结算（二十七~三十二条部分机械化）。
 * 逻辑照搬 guard.mjs 的 stop 分支：本任务 KPI → 等次 → 委托池奖惩，跨任务累计入 kpiCarry。
 * 执行池增减仍由人类批示，引擎只动委托池。
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
        state.kpiLowReported = false
      }
      saveState(file, state)
      saveLedger(projDirOf(agent), state)
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
