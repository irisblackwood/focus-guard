import { test } from "node:test";
import assert from "node:assert/strict";

// 进度/预算判定内核（母版，2026-10-25 阶段 2 第一刀）
// 此前"是否熔断 / 是否续杯 / 是否停滞熔断 / 侦查池超限"四处阈值比较在
// hooks/guard.mjs 与 src/dsh/postProgress.mjs 各写一份，现统一到母版纯函数。

const pp = await import("../src/core/progressPolicy.mjs");

test("budgetVerdict：达硬上限 → fuse；达当前预算 → refill（封顶）", () => {
  assert.deepEqual(pp.budgetVerdict({ effectiveCalls: 200, taskBudget: 50, cap: 200, refill: 10 }), { kind: "fuse" });
  assert.deepEqual(pp.budgetVerdict({ effectiveCalls: 50, taskBudget: 50, cap: 200, refill: 10 }), { kind: "refill", nextBudget: 60 });
  assert.deepEqual(pp.budgetVerdict({ effectiveCalls: 195, taskBudget: 195, cap: 200, refill: 10 }), { kind: "refill", nextBudget: 200 });
  assert.deepEqual(pp.budgetVerdict({ effectiveCalls: 10, taskBudget: 50, cap: 200, refill: 10 }), { kind: null });
});

test("budgetVerdict 边界：刚好等于 cap 即熔断（≥ 语义）", () => {
  assert.equal(pp.budgetVerdict({ effectiveCalls: 199, taskBudget: 199, cap: 200, refill: 10 }).kind, "refill");
  assert.equal(pp.budgetVerdict({ effectiveCalls: 200, taskBudget: 199, cap: 200, refill: 10 }).kind, "fuse");
});

test("stallVerdict：连续无效达阈值", () => {
  assert.equal(pp.stallVerdict({ stalledStreak: 3, threshold: 3 }).fuse, true);
  assert.equal(pp.stallVerdict({ stalledStreak: 2, threshold: 3 }).fuse, false);
});

test("invPoolOverLimit：严格大于才算超限", () => {
  assert.equal(pp.invPoolOverLimit({ invCalls: 20, invCap: 20 }), false);
  assert.equal(pp.invPoolOverLimit({ invCalls: 21, invCap: 20 }), true);
});

// ── 阶段 2 第二刀（2026-10-27）：进度判定与池归属从 postProgress 监听器搬进母版 ──
// 搬之前这两段埋在 317 行的监听器中间，既无法单测，ZCode 侧也无法复用。

test("judgeProgress：写操作恒算进度（不看签名）", () => {
  // 写操作即使内容和上次完全一样，也是进度——它改变了工作区。
  assert.equal(pp.judgeProgress({ isWrite: true, respSig: "same", inputSig: "same", prevRespSig: "same", prevInputSig: "same" }), true);
});

test("judgeProgress：响应或入参签名变化即算进度", () => {
  const base = { isWrite: false, prevRespSig: "a", prevInputSig: "b" };
  assert.equal(pp.judgeProgress({ ...base, respSig: "a2", inputSig: "b" }), true, "响应变了");
  assert.equal(pp.judgeProgress({ ...base, respSig: "a", inputSig: "b2" }), true, "入参变了");
  assert.equal(pp.judgeProgress({ ...base, respSig: "a", inputSig: "b" }), false, "两者都没变才是无效调用");
});

test("judgeProgress：首次调用（无上次签名）恒算进度", () => {
  // 上次签名为 undefined 时不能判成"没变"，否则第一条调用就被记无效。
  assert.equal(pp.judgeProgress({ isWrite: false, respSig: "", inputSig: "", prevRespSig: undefined, prevInputSig: undefined }), false,
    "空签名与缺失签名视为相同（等价于旧实现的 ?? '' 口径）");
  assert.equal(pp.judgeProgress({ isWrite: false, respSig: "x", inputSig: "", prevRespSig: undefined, prevInputSig: undefined }), true);
});

test("poolOf：委派 > 侦查 > 执行（委派不占执行池）", () => {
  assert.equal(pp.poolOf({ isDelegation: true, isInvestigation: true }), "delegate", "委派优先，即使它也是只读");
  assert.equal(pp.poolOf({ isDelegation: true, isInvestigation: false }), "delegate");
  assert.equal(pp.poolOf({ isDelegation: false, isInvestigation: true }), "investigate");
  assert.equal(pp.poolOf({ isDelegation: false, isInvestigation: false }), "execute");
  assert.equal(pp.poolOf({}), "execute", "默认进执行池");
});
