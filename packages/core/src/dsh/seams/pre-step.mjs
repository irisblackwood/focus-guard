/**
 * ③ `agent/pre-step` → UserPromptSubmit：回合重置（waterfall，必须 return next()）。
 *
 * 移植自 guard.mjs 的 reset 模式（L194-326），但**不含**已退役的审批单部分（y/n 批示识别与待批队列）：
 *   审批单只需敲一个 y，**无目的、无范围、无留档**；而 fg_apply 要求 purpose/scope 结构化留档。
 *   两套并存时人会本能选省事的那条，使"事前结构化申请"形同虚设。
 *   **留一条能绕过主设计的旁路，等于没有主设计。**
 * 误伤救济（fg_appeal）不受影响：它不是绕过，而是申辩——须附反例锚点、人类一次性裁决、全程留痕。
 * 对应条文修法见 RULES 第七十五条(三)(四)。
 *
 * 去掉脚本特有部分：process.exit / detectEnv 环境重检（依赖 env.mjs 探测链，留待后续批次）。
 *
 * 2026-10-27 拆分：从 `seams.mjs` 原样搬出（函数体 123 行），把批示识别/残留核验/落盘
 * 切成私有 helper，**判定条件、阈值、文案、审计字段一字未改**。
 */
import { saveState } from '../../core/state.mjs'
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
} from '../../core/constants.mjs'
import { noteTracePosition } from '../traceMeta.mjs'
import { auditRow, humanTextOf, isSubagent, loadOrInit, rememberWorkspace } from './shared.mjs'

export function preStepListener({ warn } = {}) {
  return async ({ agent, messages, turn, step } = {}, next) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      // 每回合补登一次工作区（2026-11-15）：`agent/created` 只在新建时触发，
      // 恢复会话、热重载、或宿主改走别的创建路径时它不响——pre-step 是唯一每回合必过的缝。
      rememberWorkspace(agent)
      // 位置元数据（2026-10-19 人类批示）：pre-step 是唯一能拿到 {turn, step} 的缝，
      // 记下来供 audit-writer 的 provider 注入（exec 上没有这两个字段）。
      noteTracePosition(sid, turn, step)
      // ── 子代理：只做回合重置，跳过批示识别 ──
      // 子代理的 prompt 由父 agent 生成、不是人类输入。实测（hermes-loop 复盘子代理）：
      // 其复盘 prompt 含"审计/全量"等词 → 命中 KEY50_RE → 额度被误判为 50，还记了无意义的 goal-preauth。
      if (isSubagent(agent)) {
        state.turnCount = 0
        state.stopBlocked = false
        saveState(file, state)
        return next()
      }
      const promptText = humanTextOf(messages)
      const short = promptText.trim()
      // 换回合判定**提前**算：残留核验与 reset-fired 都只在换回合时留痕。
      //
      // `agent/pre-step` 每个 step 都触发，而原实现两处都无条件落账 → 实测
      // （2026-11-28，session-c00d686c）：63 个真实回合记出 831 行 reset-fired
      // （avg 13、max 56）与 776 行 residue-check（avg 13.4）。整份日志 2104 行里
      // 有 1607 行是这两项，等于 76% 在记"同一个回合内的第 N 步照例又跑了一遍"。
      //
      // 「回合重置」按其语义就是回合级的：同一回合内的后续 step 不该再报一次"重置了"。
      // 单独算、不动 `saveResetState` 的 `isNewTurn`——那里同时控制
      // fused/effectiveCalls/invCalls 的归零，改它等于改执法行为，风险不对等。
      const prevTurn = state.lastTurn
      // 无 turn 的宿主（老版本/测试直调）退回「prompt 文本变了才算换回合」——
      // 比原来的 `Boolean(short)` 更严：只要有文本就算换回合，会让同一回合的每一步
      // 重新执行一遍批示识别（budget-extend 重复加额度就是这么来的）。
      const isTurnStart = Number.isInteger(turn)
        ? turn !== prevTurn
        : Boolean(short) && promptText.slice(0, 4000) !== state.turnPromptFull
      const flags = detectDirectives({ sid, state, promptText, short, isTurnStart })
      auditResidues(sid, state, flags.stopOrdered, isTurnStart)
      // 额度核定
      const kw = KEY50_RE.test(promptText) ? 50 : KEY15_RE.test(promptText) ? 15 : BUDGET_DEFAULT
      state.taskBudget = Math.max(kw, state.declaredBudget || 0, state.taskBudget || BUDGET_DEFAULT)
      state.taskInitial = state.taskBudget
      state.ineffCalls = 0
      const chain = 'T' + Date.now().toString(36)
      saveResetState({ file, state, turn, promptText, chain, flags })
      if (isTurnStart) {
        auditRow(
          sid,
          'reset-fired',
          `prompt:${promptText ? '有' : '无'}(${promptText.length}字) kw=${kw} budget=${state.taskBudget} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} stall=${state.stalledStreak || 0}${flags.creditGranted ? ' 信用延期' : ''}${flags.mercy ? ' 特赦' : ''}`,
        )
      }
    } catch (error) {
      if (typeof warn === 'function') warn('回合重置缝异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}

/**
 * 批示识别（特赦 / 目标预授权 / 信用延期 / 停止令 / 追加额度）。
 * 顺序与原实现一致：每条的审计行必须在自己的状态变更之后落。
 *
 * 只在**换回合**时识别（2026-11-28）：同一回合内 `messages` 不变，每步重判等于把同一句批示
 * 记多次。实测 goal-preauth 6 行同属 1 个回合、budget-extend 7 行只分 3 组——
 * 后者不只是多记，是**真的多加了额度**（同一句「追加额度」加 3 次 REFILL）。
 * 不换回合时沿用上一轮已认定的 mercy / goalPush，否则 saveResetState 会把它们覆写成 false，
 * 特赦在回合中途失效。
 */
function detectDirectives({ sid, state, promptText, short, isTurnStart }) {
  if (!isTurnStart) {
    return { mercy: !!state.mercy, goalPush: !!state.goalPush, creditGranted: false, stopOrdered: false }
  }
  // 特赦识别
  const grant = promptText.match(MERCY_RE)
  const mercy = !!(grant && short.length <= MERCY_SHORT)
  if (mercy) auditRow(sid, 'mercy-granted', `批示原文: ${grant[0]}`, { pardon: true })

  // 目标预授权与执行级授权分离：任务指令里的「上传/推送」只记 goal，不解锁执行标记
  const goalPush =
    /上传|推送|push/i.test(promptText) && !/(不|禁|勿|别|暂|缓)[^，。；\n]{0,6}(上传|推送|push)/i.test(promptText)
  if (goalPush) auditRow(sid, 'goal-preauth', 'goal=push-at-end（目标预授权，不构成执行级授权）')

  const creditGranted = applyCredit({ state, short })
  const stopOrdered = applyStopOrder({ sid, state, short })
  applyBudgetExtend({ sid, state, short })
  return { mercy, goalPush, creditGranted, stopOrdered }
}

/** 信用延期：连续停滞 ≥2 且收到信用批示 → 侦查池/执行池各补一次。 */
function applyCredit({ state, short }) {
  if (short.length > 12 || (state.stalledStreak || 0) < 2 || !CREDIT_RE.test(short)) return false
  state.stalledStreak = 0
  state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP)
  state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP)
  state.invWarned = false
  return true
}

/**
 * 停止令：人类明确批示停止 → 熔断。
 * （旧实现曾在回合重置末尾把 fused 硬写回 false，止停令被自己抹掉——那条已删，别再写回。）
 */
function applyStopOrder({ sid, state, short }) {
  const stopOrdered = short.length <= 12 && STOP_ORDER_RE.test(short)
  if (!stopOrdered) return false
  state.fused = true
  state.violations = Math.max(state.violations || 0, 3)
  auditRow(sid, 'stall-fuse', '人类批示停止', { level: 3 })
  return true
}

/** 24条(三) 追加批示：三池各 +REFILL。 */
function applyBudgetExtend({ sid, state, short }) {
  if (short.length > 12 || !/追加|增加额度|扩大额度/.test(short)) return
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

/** 43条 状态重置核验：上一回合残留 → 记档后清理。 */
function auditResidues(sid, state, stopOrdered, isTurnStart) {
  const residues = []
  if ((state.turnCount || 0) > 0) residues.push(`turnCount=${state.turnCount}`)
  if ((state.stalledStreak || 0) > 0) residues.push(`stall=${state.stalledStreak}`)
  if (state.fused && !stopOrdered) residues.push('fused')
  if (state.forcedInvestigate) residues.push('forcedInvestigate')
  if (state.stopBlocked) residues.push('stopBlocked')
  if (state.readSet && Object.keys(state.readSet).length) residues.push(`readSet=${Object.keys(state.readSet).length}`)
  // 有残留、**且确实在换回合**才记。
  //
  // 43条 的原意是「上一回合的残留，本回合核验后清理」——它天生是回合级的。
  // 原实现只判 `residues.length`，于是同一回合内的每一步都在报"又清理了一次"：
  // 实测 776 行里 turnCount 773 / readSet 352 / stall 48，而 fused /
  // forcedInvestigate / stopBlocked **一条都没有**——从没记下过一次执法状态的清理。
  // 这些行分不出「回合开始清上一回合的账」和「本回合第 7 步例行归零」，
  // 混在一起就被读成「残留一直在产生」。
  if (isTurnStart && residues.length) {
    auditRow(sid, 'residue-check', `43条 残留(已清理): ${residues.join(' ')}`)
  }
}

/**
 * 回合重置落盘。
 *
 * 2026-10-27 修（熔断只活一步）：`agent/pre-step` **每个 step 都触发**，而原实现无条件写
 * `fused: stopOrdered` → 熔断在**下一步**就被清掉，模型来不及看见，执法形同虚设。
 * 实测 turn 128：step 19 硬上限熔断，step 20 起 eff 仍 200→206、inv 787→793，白走 16 步。
 * 设计意图本就是"回合级状态"（下方 residue-check 已把 fused 列为待清残留）。
 * 改为：只在**换回合**（turn 变化）时重置 fused；同一回合内保留熔断。
 *
 * 2026-11-28（同日补）：当时注释写着「只动 fused，其余字段保持每步重置的现状不动」——
 * 那是在不知道代价时的最小改动。实测（session-c00d686c，2107 行日志）发现其余字段的语义
 * 同样都是「本回合 / 本任务」，每步重置等于**把执法骨架逐条关掉**：
 *   violations          → `penalize` 的三级递进（≥2 强制调查 / ≥3 熔断 / ≥5 察看）每步归零，永不成立
 *   turnCount           → `stopPolicy` 的「本回合调用 ≥N 步」与 stopGuard 的「≥5 步」同样永不成立
 *   readSet             → Read 记的账下一步就没了 → 日志里 24 条 deny **全部**落在「未取证」
 *   editedFiles         → blast-radius 阈值 6 从未触发（2107 行 0 条），批量场景（≥5 文件）同病
 *   kpiScolded          → 同一回合反复扣分（turn 100 的 step 3 与 step 12 各 -5，全日志 78 次）
 *   delegated           → 「已委派过」每步丢失，是上一条扣分的放大器
 *   kpiDelegatedAwarded → +5 可反复给
 *   probation / forcedInvestigate / stopBlocked / randomFusePending → 状态活不过一步
 * 故一并改为回合级。**只有 lastSig/lastInput 仍按步重置**——「无效调用」判定依赖单步比较，
 * 跨步共享会放大停滞误判。
 */
function saveResetState({ file, state, turn, promptText, chain, flags }) {
  const isNewTurn = Number.isInteger(turn) ? turn !== state.lastTurn : true
  saveState(file, {
    ...state, // envCache/caseCache（侦查缓存）随 spread 保留；kpi/delegateUsed 跨回合保留
    lastTurn: Number.isInteger(turn) ? turn : state.lastTurn,
    // ── 以下 11 项均为回合级：同一回合内保留，换回合才清 ──
    turnCount: isNewTurn ? 0 : state.turnCount || 0,
    stopBlocked: isNewTurn ? false : !!state.stopBlocked,
    randomFusePending: isNewTurn ? false : !!state.randomFusePending,
    violations: isNewTurn ? (flags.stopOrdered ? Math.max(state.violations || 0, 3) : 0) : state.violations || 0,
    forcedInvestigate: isNewTurn ? false : !!state.forcedInvestigate,
    probation: isNewTurn ? false : !!state.probation,
    readSet: isNewTurn ? {} : state.readSet || {},
    delegated: isNewTurn ? false : !!state.delegated,
    editedFiles: isNewTurn ? {} : state.editedFiles || {},
    kpiScolded: isNewTurn ? {} : state.kpiScolded || {},
    kpiDelegatedAwarded: isNewTurn ? false : !!state.kpiDelegatedAwarded,
    fused: isNewTurn ? flags.stopOrdered : state.fused,
    // 2026-10-28 修（熔断太容易）：`effectiveCalls`/`invCalls` 是**回合级**计数
    // （预算与硬上限都按"本回合有效调用"判），原实现跨回合累计且从不归零——
    // 一旦会话累计到 BUDGET_CAP，之后每个有效调用都重新置 fused，换回合也解不开。
    effectiveCalls: isNewTurn ? 0 : state.effectiveCalls,
    invCalls: isNewTurn ? 0 : state.invCalls,
    invWarned: isNewTurn ? false : state.invWarned,
    mercy: flags.mercy,
    goalPush: flags.goalPush,
    turnPrompt: promptText.slice(0, 500),
    turnPromptFull: promptText.slice(0, 4000),
    taskBudget: state.taskBudget,
    taskInitial: state.taskInitial,
    taskChain: chain,
    lastSig: '',
    lastInput: '',
  })
}
