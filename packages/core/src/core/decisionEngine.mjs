// FocusGuard 母版层 · 模型决策层（3.0.5）
//
// 职责：request + state + profile → 调 checkEligibility → 汇总 decision / layer / skipped。
// 纪律：本层**不做任何判定**，只做编排与汇总；判定权全在 checkEligibility（逻辑层是法官）。
// 跳过的层由 checkEligibility 写进 trace（decision:"skip"），本层负责提炼成 skipped 清单，
// 供适配层写进 AUDIT.log 的 trace 字段。
//
// 接入状态（2026-11-26 接线）：
//   · `adapters/dsh/eligibility-gate.mjs:applyOneEligibility` 已改走 `decide()`，返回值带
//     skipped / profileId / profileSource——`fg_apply` 路径因此能说清「哪几层被画像关掉」；
//   · `gateToolCall`（pre-execute 的 grants 校验）**仍未接入，且不应接入**：它是同步函数，
//     只查授权表、不进判定链；接进来等于把异步判定塞进 pre-execute 热路径；
//   · `hooks/guard.mjs` 仍走自己的判定链（已封存，不随主版本演进）。
//
// 语义约束（接线时踩到的坑）：`profile: null` 必须保持 null，不能退化成「按 modelId 加载」。
// 「不传画像 = 全层启用（最严）」由 integration b4 锁定，写成 `??` 就会破坏它。
//
// 职责边界不变：本层**不做任何判定**，判定权全在 checkEligibility（逻辑层是法官）。

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
  // `null` 是显式「无画像」，`undefined` 才是「没给，按 modelId 解析」。
  // 不能用 `??`：那会把 null 当成没给，于是「不传画像 = 全层启用（最严）」这条既有语义
  // 会被偷换成「加载 default 画像」——integration b4 锁着它。
  const resolved = profile !== undefined ? profile : loadProfile(modelId);
  const result = await checkEligibility({ ...request, profile: resolved });
  return {
    decision: result.decision,
    layer: result.layer,
    reason: result.reason,
    modelSignal: result.modelSignal,
    profileId: resolved ? resolved.id : null,
    profileSource: resolved ? resolved.profileSource : null,
    skipped: skippedFromTrace(result.trace),
    trace: result.trace,
  };
}
