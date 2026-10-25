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
