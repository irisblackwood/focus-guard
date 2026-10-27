/**
 * 进度/预算判定内核（母版逻辑，2026-10-25 阶段 2 第一刀）
 *
 * 判据：母版是逻辑，适配层只做翻译。此前"是否熔断 / 是否续杯 / 是否停滞熔断"三处阈值比较
 * 在 `hooks/guard.mjs` 与 `src/dsh/postProgress.mjs` 各写一份。
 *
 * 本模块只做**比较与结论**，不写状态、不发审计、不提示：
 *   postProgress → 拿结论后自己落 state + audit
 *   guard.mjs    → 同上（其打回/exit 属翻译层）
 */

/**
 * @param {{ effectiveCalls?: number, taskBudget?: number, cap: number, refill: number }} p
 * @returns {{ kind: 'fuse' | 'refill' | null, nextBudget?: number }}
 */
export function budgetVerdict({ effectiveCalls = 0, taskBudget = 0, cap, refill }) {
  if (effectiveCalls >= cap) return { kind: 'fuse' }
  if (effectiveCalls >= taskBudget) return { kind: 'refill', nextBudget: Math.min(taskBudget + refill, cap) }
  return { kind: null }
}

/**
 * 停滞熔断：连续无效调用达到阈值。
 * @param {{ stalledStreak?: number, threshold: number }} p
 */
export function stallVerdict({ stalledStreak = 0, threshold }) {
  return { fuse: stalledStreak >= threshold }
}

/**
 * 侦查池超限（只提醒一次，由调用方用 invWarned 去重）。
 * @param {{ invCalls?: number, invCap: number }} p
 */
export function invPoolOverLimit({ invCalls = 0, invCap }) {
  return invCalls > invCap
}

/**
 * 进度判定（2026-10-27 阶段 2 第二刀）：写操作恒算进度；否则响应签名或入参签名变化即算进度。
 *
 * 签名由适配层算好传入（母版不做序列化，避免绑定宿主形态——DSH 的 callHash 与 ZCode 的不同）。
 * 此前这段判定只在 `postProgress.mjs` 的监听器里，317 行的长函数把它埋在中间，
 * 既无法单测，也无法在 ZCode 侧复用。
 *
 * @param {{ isWrite?: boolean, respSig?: string, inputSig?: string, prevRespSig?: string, prevInputSig?: string }} p
 * @returns {boolean}
 */
export function judgeProgress({ isWrite = false, respSig = '', inputSig = '', prevRespSig, prevInputSig }) {
  if (isWrite) return true
  return respSig !== (prevRespSig ?? '') || inputSig !== (prevInputSig ?? '')
}

/**
 * 调用池归属（2026-10-27 阶段 2 第二刀）：委派独立核算，侦查进侦查池，其余进执行池。
 *
 * 三池分立的语义：委派不占主会话执行池（委托池在 pre 侧核算）；只读侦查不挤占执行额度。
 * 此前是三段 if/else if 散在监听器里，加一个池就得改一次控制流。
 *
 * @param {{ isDelegation?: boolean, isInvestigation?: boolean }} p
 * @returns {'delegate' | 'investigate' | 'execute'}
 */
export function poolOf({ isDelegation = false, isInvestigation = false }) {
  if (isDelegation) return 'delegate'
  return isInvestigation ? 'investigate' : 'execute'
}
