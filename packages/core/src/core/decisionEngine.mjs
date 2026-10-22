// FocusGuard 母版层 · 模型决策层（3.0.5）
//
// 职责：request + state + profile → 调 checkEligibility → 汇总 decision / layer / skipped。
// 纪律：本层**不做任何判定**，只做编排与汇总；判定权全在 checkEligibility（逻辑层是法官）。
// 跳过的层由 checkEligibility 写进 trace（decision:"skip"），本层负责提炼成 skipped 清单，
// 供适配层写进 AUDIT.log 的 trace 字段。
//
// ⚠ 接入状态（2026-10-22 层序审查，实测确认）：
//   生产路径**尚未接入**本模块。
//     · `dsh/pipeline.mjs` 的资格闸直调 `adapters/dsh/eligibility-gate.mjs:gateToolCall`
//       （内部同样调 checkEligibility），并自己 `loadProfile(modelId)` 传进去；
//     · `hooks/guard.mjs` 走自己的判定链。
//   本模块当前只被 3 个测试使用：integration / profile / acceptance。
//
// 保留而非删除：它是「画像 → 判定 → skipped/trace 汇总」的完整编排，而 DSH 侧只手工做了
// 其中一半（有 profile 传递，缺 skipped/trace 汇总）。
// **接入属行为变更**：会改变 gateToolCall 的返回结构与写进 AUDIT.log 的 trace 字段，
// 必须单独评估并补测试，不要在重构里顺手接上。

import { checkEligibility } from "./checkEligibility.mjs";
import { loadProfile } from "./profileLoader.mjs";

/** 从 trace 里取出被跳过的层 { layer, reason }[]。 */
export function skippedFromTrace(trace = []) {
  return trace
    .filter((s) => s && s.decision === "skip")
    .map((s) => ({ layer: s.layer, reason: s.reason }));
}

/** 从 trace 里取出真正参与判定的层（decision 非 skip）。 */
export function activeFromTrace(trace = []) {
  return trace.filter((s) => s && s.decision !== "skip");
}

/**
 * 按画像决策一次。
 * @param {object} req
 * @param {string} [req.modelId] 模型标识；未给 profile 时用它加载画像（匹配不到即 default）
 * @param {object} [req.profile] 直接传入画像对象（优先于 modelId）
 * @param {Function} [req.audit] 审计写入（注入；checkEligibility 会带 skipped 一起写）
 * @param {object} [req.state] 会话状态
 * @returns {Promise<{decision, layer, reason, modelSignal, profileId, profileSource, skipped, trace}>}
 */
export async function decide({ modelId, profile, ...request } = {}) {
  const resolved = profile ?? loadProfile(modelId);
  const result = await checkEligibility({ ...request, profile: resolved });
  return {
    decision: result.decision,
    layer: result.layer,
    reason: result.reason,
    modelSignal: result.modelSignal,
    profileId: resolved.id,
    profileSource: resolved.profileSource,
    skipped: skippedFromTrace(result.trace),
    trace: result.trace,
  };
}
