// FocusGuard 母版层 · 模型决策层（3.0.5）
//
// 职责：request + state + profile → 调 checkEligibility → 汇总 decision / layer / skipped。
// 纪律：本层**不做任何判定**，只做编排与汇总；判定权全在 checkEligibility（逻辑层是法官）。
// 跳过的层由 checkEligibility 写进 trace（decision:"skip"），本层负责提炼成 skipped 清单，
// 供适配层写进 AUDIT.log 的 trace 字段。

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
