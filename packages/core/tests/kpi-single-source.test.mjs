import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// KPI 等次结算单点化（2026-10-22，分层泄漏修复 P4）
// 病根：`hooks/guard.mjs`（ZCode 层）与 `src/dsh/seams.mjs`（DSH 缝）各写一份
// 「KPI → 等次 → 委托池 ±N」判定，属同源双写；今天 KPI 修复已踩过"改一边、另一边照旧"的风险。
// 现在收敛到 `core/kpi.mjs`：本组锁 ① 阈值行为 ② 两侧都真的 import 了它（防被复制回去）。

const { gradeOfKpi } = await import("../src/core/kpi.mjs");

test("阈值：优秀 / 称职 / 基本称职 / 不称职", () => {
  assert.deepEqual(gradeOfKpi(15), { grade: "优秀", poolDelta: 5 });
  assert.deepEqual(gradeOfKpi(100), { grade: "优秀", poolDelta: 5 });
  assert.deepEqual(gradeOfKpi(0), { grade: "称职", poolDelta: 0 });
  assert.deepEqual(gradeOfKpi(14), { grade: "称职", poolDelta: 0 });
  assert.deepEqual(gradeOfKpi(-1), { grade: "基本称职", poolDelta: -2 });
  assert.deepEqual(gradeOfKpi(-9), { grade: "基本称职", poolDelta: -2 });
  assert.deepEqual(gradeOfKpi(-10), { grade: "不称职", poolDelta: -5 });
});

test("异常输入不炸：undefined / NaN / 字符串", () => {
  assert.equal(gradeOfKpi(undefined).grade, "称职");
  assert.equal(gradeOfKpi(NaN).grade, "称职");
  assert.equal(gradeOfKpi("-12").grade, "不称职");
});

test("两侧都引用母版实现（防双写回归）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const guard = readFileSync(join(here, "..", "hooks", "guard.mjs"), "utf8");
  const seams = readFileSync(join(here, "..", "src", "dsh", "seams.mjs"), "utf8");
  assert.match(guard, /from "\.\.\/src\/core\/kpi\.mjs"/, "hooks/guard.mjs 应 import core/kpi.mjs");
  assert.match(seams, /from '\.\.\/core\/kpi\.mjs'/, "src/dsh/seams.mjs 应 import core/kpi.mjs");
  assert.doesNotMatch(guard, /grade = "优秀"/, "guard.mjs 不得再内联等次判定");
  assert.doesNotMatch(seams, /grade = '优秀'/, "seams.mjs 不得再内联等次判定");
});
