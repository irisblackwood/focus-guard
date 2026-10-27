/**
 * focus-guard 原生插件 · 宿主缝组装根（3.0.8 · 孤儿机制移植；2026-10-27 拆分）
 *
 * 背景：原生插件原本只注册 pipeline.mjs 的三条缝（tools/pre-execute、system-prompt/assemble、
 * tools/post-execute），而 guard.mjs 的六条缝里另有三条在 DSH 侧没有对应实现——于是
 * KPI / 三预算池 / 审批单 / 抽查 / 污染检测 / 因果链 / 图书馆 / 降级 / 绝境等机制
 * 全都停在 guard.mjs（封存且未挂载）里，DSH 用户拿不到。
 *
 * 本文件按官方桥（@deepseek-ai/dsh-hooks-claude-code）已验证的事件映射接上缺失的缝：
 *   SessionStart      ← agent/created       （sessionStartListener · seams/session-start.mjs）
 *   UserPromptSubmit  ← agent/pre-step      （preStepListener · waterfall，必须 return next()）
 *   Stop              ← agent/turn-stopping （turnStoppingListener · KPI 兑现结算）
 *
 * 2026-10-27 拆分：原文件 498 行、四个监听器挤在一处（超结构异味阈值 文件 400 行 / 函数 80 行 /
 * 嵌套 5 层）。现为「组装根 + turn-stopping」：session-start / prompt-rules / pre-step 各自独立模块，
 * 本文件只负责 re-export 与 KPI 结算（turnStoppingListener 留在本文件，因 `tests/kpi-single-source.test.mjs`
 * 直接断言 `src/dsh/seams.mjs` 里出现 `from '../core/kpi.mjs'`——换文件即失去那条防双写的锁）。
 * **纯搬运**：导出名/签名、判定条件、阈值、文案、审计字段一字未改。
 *
 * 取值口径与桥一致（lib/index.js:349-354）——**这不是可选项**（详见 seams/shared.mjs）：
 *   sid = agent.session.header.id   ← 用 agent.session.id 会取不到，于是全部会话退化成同一个
 *                                      'dsh-native'，造成跨会话状态污染。
 *   cwd = agent.session.header.cwd ?? process.cwd()
 *   人类文本 = messages.flatMap(m => m.content).filter(b => b.type==='text').map(b => b.text).join('')
 *
 * 纪律：所有写入经 appendAudit / saveState / saveLedger（均 fail-open + 留痕）；
 * 任一缝异常只 warn，绝不断开 DSH 主流程。
 */
import { saveState, saveLedger } from '../core/state.mjs'
import { gradeOfKpi } from '../core/kpi.mjs'
import { BUDGET_CAP, DELEGATE_DEFAULT } from '../core/constants.mjs'
import { auditRow, loadOrInit, projDirOf } from './seams/shared.mjs'

export { sessionStartListener } from './seams/session-start.mjs'
export { systemPromptRulesListener } from './seams/prompt-rules.mjs'
export { preStepListener } from './seams/pre-step.mjs'

/**
 * ③ agent/turn-stopping → Stop：KPI 兑现结算（二十七~三十二条部分机械化）。
 * 逻辑照搬 guard.mjs 的 stop 分支：本任务 KPI → 等次 → 委托池奖惩，跨任务累计入 kpiCarry。
 * 执行池增减仍由人类批示，引擎只动委托池。
 */
export function turnStoppingListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      // 顺序固定：ttl 回收 → 改动面报告 → KPI 结算（后两步都依赖前一步不留残留）。
      await sweepTurnGrants(sid, warn)
      await reportBlastRadius(sid, state)
      await settleKpi({ agent, sid, file, state })
    } catch (error) {
      if (typeof warn === 'function') warn('KPI 结算缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}

/**
 * 2026-10-18 补口：ttl 回收（此前 ttl 只记录、从不回收，fg_apply 申请一次便永久放行）。
 * 必须在最前——KPI 无增量时会提前 return，回收不能因此被跳过。
 */
async function sweepTurnGrants(sid, warn) {
  try {
    const { sweepGrants } = await import('../adapters/dsh/eligibility-gate.mjs')
    sweepGrants(sid, 'turn')
  } catch (error) {
    if (typeof warn === 'function') warn('授权 ttl 回收异常（不阻塞）:', (error && error.message) || error)
  }
}

/**
 * 2026-10-25：改动面收尾报告——必须在 KPI 零增量提前 return **之前**执行，
 * 否则没有 KPI 增量的回合（大多数回合）永远报不出来。
 * 只统计 FG 亲眼看过的写操作（state.editedFiles），阈值 FG_BLAST_REPORT（默认 6，0=关闭）。
 */
async function reportBlastRadius(sid, state) {
  try {
    const threshold = Number(process.env.FG_BLAST_REPORT ?? 6)
    const touched = Object.keys(state.editedFiles || {})
    if (threshold > 0 && touched.length >= threshold) {
      const { noteLivenessEvent } = await import('./heartbeat.mjs')
      noteLivenessEvent(`blast:${touched.length}`)
      auditRow(sid, 'blast-radius', `本轮改动 ${touched.length} 个文件（阈值 ${threshold}）：${touched.slice(0, 6).join(', ')}`)
    }
  } catch {
    /* 报告失败不影响结算 */
  }
}

/** KPI 增量结算（二十七~三十二条）：本任务 KPI → 等次 → 委托池奖惩 + 跨任务累计。 */
async function settleKpi({ agent, sid, file, state }) {
  // 2026-10-18 修（REPORT-2026-10-12「KPI 重复结算」）：state.kpi 是**会话累计值**，
  // 而本缝每回合都跑一次。原实现把累计值当成"本任务 KPI"：
  //   ① `kpiCarry += kpiNow` 每回合重复累加 → ΣΣ（实测 -10 被记成 -80）；
  //   ② 委托池按累计值每回合重复扣/加。
  // 改为按**增量**结算：kpiNow = 当前累计 - 上次已结算基线；无增量则零动作。
  const settledBase = Number.isFinite(state.kpiSettled) ? state.kpiSettled : 0
  const kpiNow = (state.kpi || 0) - settledBase
  if (kpiNow === 0) {
    state.kpiSettled = state.kpi || 0
    saveState(file, state)
    return
  }
  state.kpiSettled = state.kpi || 0
  // 等次判定收敛到母版 `core/kpi.mjs`（此前与 hooks/guard.mjs 各写一份，属同源双写）。
  const { grade, poolDelta } = gradeOfKpi(kpiNow)
  state.delegateBudget = Math.max(0, Math.min(BUDGET_CAP, (state.delegateBudget ?? DELEGATE_DEFAULT) + poolDelta))
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
  await publishKpiSnapshot(state)
  auditRow(
    sid,
    'kpi-settle',
    `二十七~三十二条 兑现 KPI=${kpiNow} 等次=${grade} 委托池${poolDelta >= 0 ? '+' : ''}${poolDelta}（现=${state.delegateBudget}）跨任务累计=${state.kpiCarry}`,
  )
}

/**
 * 2026-10-22（人类反馈"KPI 感觉不到"）：把结算结果交给心跳快照，让它在
 * ① status.json ② 下一次 FG 徽标（拦截/申请/压缩）里可见。不参与任何判定。
 */
async function publishKpiSnapshot(state) {
  try {
    const { setKpiSnapshot } = await import('./heartbeat.mjs')
    setKpiSnapshot({ kpi: state.kpi || 0, delegateBudget: state.delegateBudget })
  } catch {
    /* 展示失败不影响结算 */
  }
}
