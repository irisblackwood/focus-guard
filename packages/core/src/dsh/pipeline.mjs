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
 *   writingGate（1.3 动笔闸）· wholeFile（1.4 整读闸）· hardCheck（1.5 硬校验）·
 *   authz（资格闸 + 改动面闸）· volume（体积/污染）· risk（第2层语义）· runtime（版本/成本）。
 * 导出面保持不变：调用方（index.js / tests / selftest）无需改动。
 */
import { auditDeny } from './audit.mjs'
// 适配层语义注册（工具名→类别、只读动作表）：与 preGuard 同口径；组装根依赖适配层是允许的。
import '../adapters/dsh/tool-kinds.mjs'
import { commandOf } from './guard/tooling.mjs'
import { sidOf } from './sessionScope.mjs'
import { rememberReads, evidenceStage } from './guard/evidence.mjs'
import { redlineStage } from './guard/redline.mjs'
import { writingGateStage } from './guard/writing-gate.mjs'
import { wholeFileStage } from './guard/wholeFile.mjs'
import { hardCheckStage } from './guard/hardCheck.mjs'
import { eligibilityStage, valueGateStage } from './guard/authz.mjs'
import { volumeStage, pollutionStage } from './guard/volume.mjs'
import { OBSERVATION, riskOfSentinel, riskStage } from './guard/risk.mjs'
import { warnIfStaleOnce } from './guard/runtime.mjs'
// 阶段定序（母版纯函数）：顺序写成 before/after 声明，由拓扑排序推出，不靠数组书写位置。
import { orderStages, stageIds } from '../core/stageGraph.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { grantsFor } from '../adapters/dsh/eligibility-gate.mjs'
import { sameCommandFailed } from './guard/retryGuard.mjs'

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
    before: ['writingGate', 'wholeFile', 'hardCheck', 'eligibility', 'valueGate', 'volume', 'pollution', 'risk'],
  },
  { id: 'writingGate', run: writingGateStage },
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

/**
 * 轻量模式（2026-11-21）：`FG_MODE=lite` 只保留**红线 + 环境硬校验 + 资格闸**，
 * 跳过其余语义判定段。用途：日常写代码/聊天时不付"拦→重试"的额外步数，
 * 危险操作前再用默认（full）模式。红线仍在，所以 `rm -rf /`、`git push -f` 级别不放松。
 */
const LITE_SKIP_STAGES = new Set(['writingGate', 'wholeFile', 'valueGate', 'volume', 'pollution', 'risk'])

/**
 * 轻量模式开关：环境变量 `FG_MODE=lite|full` 优先；没有环境变量时读
 * `$DSH_HOME/focus-guard-mode.txt`（内容 `lite` 即开启）。
 * 文件开关是为了绕开「改用户环境变量要重启 Shell/Explorer 才生效」的坑。
 */
function liteModeFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'focus-guard-mode.txt')
}

export function isLiteMode() {
  const env = String(process.env.FG_MODE || '').trim().toLowerCase()
  if (env) return env === 'lite'
  try {
    return readFileSync(liteModeFile(), 'utf8').trim().toLowerCase() === 'lite'
  } catch {
    return false
  }
}

export function preExecuteListener({ warn, riskOf = riskOfSentinel, observe = OBSERVATION, statePath } = {}) {
  return async (exec, next) => {
    rememberReads(exec)

    // ===== 3.0.7：误伤申辩入口（必须最先处理）=====
    // 申辩参数必然携带被拦的危险命令原文，若走后续红线/资格闸会被同一规则再拦一次（死循环）。
    // DSH 契约：返回 {kind:"ask"} 经 approval seam 交人类一次性裁决（dsh-tools/lib/index.js:3226）。
    // 这是"司法救济"通道——个案当场申辩，不必等修法（见 RULES 第八十三条(四)）。
    if (String((exec && exec.name) || '') === 'fg_appeal') {
      try {
        const { recoverAppeal, appealAsk } = await import('../adapters/dsh/eligibility-gate.mjs')
        // 宿主 approval=never 时的离线通道：人类在终端 approve 过 → 直接生效
        if (await recoverAppeal(exec, warn)) return next()
        const ask = await appealAsk(exec, warn)
        if (ask) return ask
      } catch (error) {
        warn('申辩处理异常，fail-open 放行：', (error && error.message) || error)
      }
    }

    const ctx = { exec, next, warn, cmd: null, statePath, riskOf, observe }

    // 2026-11-22 · 重复命令闸：同一条命令原样重试（此前已失败 ≥2 次）直接拒绝。
    // 只认可观测事实（同工具 + 同参数 + 上次失败），不猜意图；`FG_RETRY_GUARD=0` 关闭。
    try {
      const fails = sameCommandFailed(exec)
      if (fails) {
        const label = String((exec && exec.name) || 'tool')
        const reason =
          `focus-guard-native: [重复命令闸] ${label} 同一参数已连续失败 ${fails} 次，原样重试无效。` +
          '先读上一次的错误输出，换参数/换工具，或说明为什么这次会不同；不要重复提交同一条调用。'
        auditDeny(exec, reason, { trigger: 'retry-same-command', level: 2 })
        warn('重复命令闸拦截：', reason)
        return { kind: 'deny', reason }
      }
    } catch {
      /* 闸自身异常不影响主流程 */
    }

    // 2026-11-21（ARCH-MAP #12）：把"该工具已被 fg_apply 授权"这一事实带进 ctx，
    // riskStage 据此跳过第 2 层 ask——否则 L6 放行、L2 仍问，授权闭环断开。
    try {
      const sid = sidOf(exec)
      ctx.granted = grantsFor(sid).has(String((exec && exec.name) || ''))
    } catch {
      ctx.granted = false
    }

    const lite = isLiteMode()
    const layer3 = lite ? null : await evidenceStage(ctx)
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
      if (lite && LITE_SKIP_STAGES.has(stage.id)) continue
      const verdict = await stage.run(ctx)
      if (verdict) return verdict
    }
    return next()
  }
}
