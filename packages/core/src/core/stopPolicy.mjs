/**
 * 收尾判定内核（母版逻辑唯一真源，2026-10-25）
 *
 * 人类判据：**母版是逻辑，其他只是适配；适配层只做翻译。**
 * 此前"收尾该不该打回/该不该提醒"的判定在 `hooks/guard.mjs`（ZCode/Claude Code 缝）与
 * `src/dsh/stopGuard.mjs`（DSH 缝）各写一份，条件语句几乎逐字重复（`stopBlocked` / `stopReentry`
 * / `EVIDENCE_ANCHORS` / `DOWNGRADE_MARKERS` 四件套各判一次）。
 *
 * 本模块只输出**判定结果**，不产生任何副作用：
 *   - 不发提示、不写审计、不 process.exit（那是适配层的事）
 *   - 不读文件、不碰宿主（纯函数入参出参）
 *
 * 两个宿主缝拿结果后各自翻译：
 *   guard.mjs   → block() 打回 / process.exit
 *   stopGuard   → advisory 提示 / 只审计（DSH 无 stop 拦截口）
 */

import { EVIDENCE_ANCHORS, DOWNGRADE_MARKERS } from './constants.mjs'

/**
 * 是否出现"熔断声明"或等价的未知声明（守卫：连续两次未知声明也算）。
 * @param {string} text
 */
export function declaresFuse(text) {
  const t = String(text || '')
  return /【熔断】/.test(t) || t.includes('查无依据') || t.includes('查无实据')
}

/**
 * 声明熔断但缺降级方案 → 应打回/提示一次。
 * 一次性：`stopBlocked` 已置或宿主带 `stopReentry`（打回后再次触发）时不再重复。
 */
export function needsDowngrade({ text, state = {}, stopReentry = false } = {}) {
  return (
    String(text || '').includes('【熔断】') &&
    !DOWNGRADE_MARKERS.test(String(text || '')) &&
    !state.stopBlocked &&
    !stopReentry
  )
}

/** 熔断已触发、却未交代降级方案 → 应打回/提示一次（与 needsDowngrade 的区别：前者靠声明，这里靠状态）。 */
export function needsAccount({ text, state = {}, stopReentry = false } = {}) {
  const t = String(text || '')
  return Boolean(state.fused) && !EVIDENCE_ANCHORS.test(t) && !DOWNGRADE_MARKERS.test(t) && !state.stopBlocked && !stopReentry
}

/**
 * 本回合调用 ≥5 且收尾无证据锚点 → 触发②。
 * @param {{ text: string, state?: object, min?: number }} p
 */
export function needsAnchorCheck({ text, state = {}, min = 5 } = {}) {
  const t = String(text || '')
  return (state.turnCount || 0) >= min && !EVIDENCE_ANCHORS.test(t) && !state.stopBlocked
}

/** 收尾是否带证据锚点（供适配层直接复用，避免各自引常量）。 */
export function hasAnchor(text) {
  return EVIDENCE_ANCHORS.test(String(text || ''))
}
