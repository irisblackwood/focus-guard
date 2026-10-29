/**
 * focus-guard 原生插件 · 三缝流水线（3.0.5）
 *
 * ① tools/pre-execute：rm -rf 族拦截 + 审计留痕；
 * ② system-prompt/assemble：峰谷成本提示行注入；
 * ③ tools/post-execute：token 用量折算 → 成本台账落卷（只观测，不改决策）。
 *
 * 各缝独立 fail-open：判定/注入/核算异常一律放行或原样透传，绝不阻塞 DSH 主流程。
 * 缝契约证据（本机 DSH Desktop 0.2.0-rc.2 装机源码）：
 *   - dsh-tools/lib/index.js:3225  pre-execute 瀑布 fallback {kind:"allow"}，gate.kind==="ask" 走审批；
 *   - dsh-hooks-claude-code/lib/index.js:255-258  deny 形状 {kind:"deny", reason}；
 *   - dsh-tools/lib/index.js:3504  post-execute 三参瀑布 (exec, result, next)。
 *
 * 2026-10-27：本文件从 1242 行收敛为「注册 + 顺序编排」。各层实现见 src/dsh/guard/：
 *   tooling（工具/路径取形）· evidence（第3层取证）· redline（第1层红线）·
 *   superpowers（1.3 动笔闸）· wholeFile（1.4 整读闸）· hardCheck（1.5 硬校验）·
 *   authz（资格闸 + 改动面闸）· volume（体积/污染）· risk（第2层语义）· runtime（版本/成本）。
 * 导出面保持不变：调用方（index.js / tests / selftest）无需改动。
 */
import { auditDeny } from './audit.mjs'
// 适配层语义注册（工具名→类别、只读动作表）：与 preGuard 同口径；组装根依赖适配层是允许的。
import '../adapters/dsh/tool-kinds.mjs'
import { commandOf } from './guard/tooling.mjs'
import { rememberReads, evidenceStage } from './guard/evidence.mjs'
import { redlineStage } from './guard/redline.mjs'
import { superpowersStage } from './guard/superpowers.mjs'
import { wholeFileStage } from './guard/wholeFile.mjs'
import { hardCheckStage } from './guard/hardCheck.mjs'
import { eligibilityStage, valueGateStage } from './guard/authz.mjs'
import { volumeStage, pollutionStage } from './guard/volume.mjs'
import { OBSERVATION, riskOfSentinel, riskStage } from './guard/risk.mjs'
import { warnIfStaleOnce } from './guard/runtime.mjs'
// 阶段定序（母版纯函数）：顺序写成 before/after 声明，由拓扑排序推出，不靠数组书写位置。
import { orderStages, stageIds } from '../core/stageGraph.mjs'

// 各缝原有导出原样转发（引用面：index.js / tests / tools/selftest.mjs）。
export { ABSOLUTE_REDLINES } from '../core/redlines.mjs'
export { redlineOf } from './guard/redline.mjs'
export { STATE_GATE, EVIDENCE_GATE, readGuardState } from './guard/evidence.mjs'
export {
  RISK_ASK_THRESHOLD,
  riskOfHeuristic,
  riskOfSentinel,
  resetSentinelCache,
  sentinelCacheStats,
} from './guard/risk.mjs'
export { isMutatingTool } from './guard/tooling.mjs'
export { hardCheck } from './guard/hardCheck.mjs'
export { systemPromptListener, postExecuteListener } from './guard/runtime.mjs'

/**
 * pre-execute 阶段表（2026-10-29 改为声明式 + 拓扑定序）。
 *
 * 每个阶段的契约：返回 falsy → 继续下一段；返回决策 → 立即生效；
 * 自身异常在其内部 catch，按原语义 fail-open（放行下游或继续下一段）。
 *
 * 顺序此前只存在于**数组的书写位置**里：想表达「红线必须最先」只能写注释，
 * 而注释不会被执行，挪一行数组没有任何东西会红。现在它是 `before` 声明，
 * 由 `orderStages` 推出顺序——顺序意图变成可断言的东西。
 *
 * 只有 `redline` 声明了硬约束（它是最硬的拒绝，且拒绝不需要任何前置信息）。
 * 其余段落没有强制的先后，靠**稳定排序保持输入顺序**——不为了"用上拓扑"
 * 去编造约束，那等于把数组换个写法。
 */
const PRE_STAGES = orderStages([
  {
    id: 'redline',
    run: redlineStage,
    before: ['superpowers', 'wholeFile', 'hardCheck', 'eligibility', 'valueGate', 'volume', 'pollution', 'risk'],
  },
  { id: 'superpowers', run: superpowersStage },
  { id: 'wholeFile', run: wholeFileStage },
  { id: 'hardCheck', run: hardCheckStage },
  { id: 'eligibility', run: eligibilityStage },
  { id: 'valueGate', run: valueGateStage },
  { id: 'volume', run: volumeStage },
  { id: 'pollution', run: pollutionStage },
  { id: 'risk', run: riskStage },
])

/**
 * 定序结果的 id 序列——供 `tests/stage-graph.test.mjs` 锁住顺序不变量。
 * 改顺序要么改声明、要么改这里，两者都得过测试。
 */
export const PRE_STAGE_ORDER = stageIds(PRE_STAGES)

export function preExecuteListener({ warn, riskOf = riskOfSentinel, observe = OBSERVATION, statePath } = {}) {
  return async (exec, next) => {
    rememberReads(exec)

    // ===== 3.0.7：误伤申辩入口（必须最先处理）=====
    // 申辩参数必然携带被拦的危险命令原文，若走后续红线/资格闸会被同一规则再拦一次（死循环）。
    // DSH 契约：返回 {kind:"ask"} 经 approval seam 交人类一次性裁决（dsh-tools/lib/index.js:3226）。
    // 这是"司法救济"通道——个案当场申辩，不必等修法（见 RULES 第八十三条(四)）。
    if (String((exec && exec.name) || '') === 'fg_appeal') {
      try {
        const { appealAsk } = await import('../adapters/dsh/eligibility-gate.mjs')
        const ask = await appealAsk(exec, warn)
        if (ask) return ask
      } catch (error) {
        warn('申辩处理异常，fail-open 放行：', (error && error.message) || error)
      }
    }

    const ctx = { exec, next, warn, cmd: null, statePath, riskOf, observe }

    const layer3 = await evidenceStage(ctx)
    if (layer3) {
      // trigger 由判定点给出（反规避抽查B 记 random-fuse；其余仍是 evidence-gate），审计才能回答"为什么被拦"。
      auditDeny(exec, layer3.reason, { trigger: layer3.trigger || 'evidence-gate', level: 3 })
      warn('第3层拦截：', layer3.reason)
      return layer3
    }
    warnIfStaleOnce(warn)

    try {
      ctx.cmd = commandOf(exec)
    } catch (error) {
      warn('红线判定异常，fail-open 放行：', (error && error.message) || error)
      return next()
    }

    for (const stage of PRE_STAGES) {
      const verdict = await stage.run(ctx)
      if (verdict) return verdict
    }
    return next()
  }
}
