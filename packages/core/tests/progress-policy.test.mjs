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
