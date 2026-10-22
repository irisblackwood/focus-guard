/**
 * KPI 等次结算（母版唯一真源，2026-10-22）
 *
 * 此前 `hooks/guard.mjs`（ZCode 层）与 `src/dsh/seams.mjs`（DSH 缝）各写一份同样的
 * 「KPI → 等次 → 委托池 ±N」判定，属于同源逻辑双写：改一边、另一边照旧（今天的 KPI 修复就踩过这个风险）。
 * 现收敛到本文件；两个宿主侧都只调它。
 */

/** @param {number} kpi 会话累计 KPI @returns {{grade: string, poolDelta: number}} */
export function gradeOfKpi(kpi) {
  const v = Number(kpi) || 0
  if (v >= 15) return { grade: '优秀', poolDelta: 5 }
  if (v >= 0) return { grade: '称职', poolDelta: 0 }
  if (v >= -9) return { grade: '基本称职', poolDelta: -2 }
  return { grade: '不称职', poolDelta: -5 }
}
