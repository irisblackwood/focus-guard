// FocusGuard 3.0.5 模型画像验收用例
//
// 覆盖领导指定的四条验收 + 关键回归（不传 profile 时行为与 3.0.4 一致）。
// 运行：node --test packages/core/tests/profile.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkEligibility } from "../src/core/checkEligibility.mjs";
import { loadProfile, PROFILES, LAYER_SWITCHES, layerEnabled, unimplementedSwitches } from "../src/core/profileLoader.mjs";
import { decide, skippedFromTrace, activeFromTrace } from "../src/core/decisionEngine.mjs";

const PROFILE_IDS = ["deepseek-flash", "deepseek-pro", "glm", "gpt-astra", "default"];

// 未取证的改动请求：L4 应 deny（evidenceGate on）/ 跳过（evidenceGate off）
const UNEVIDENCED = {
  tool: "Write",
  command: "rm -f ./tmp/a.txt",
  target: "./tmp/a.txt",
  purpose: "清理临时文件",
  scope: "仅 ./tmp/a.txt",
  state: { readSet: {} },
};

describe("3.0.5 · 模型画像", () => {
  test("验收 1：五个画像加载正常", () => {
    assert.equal(Object.keys(PROFILES).length, 5, "注册表应正好 5 个画像");
    for (const id of PROFILE_IDS) {
      const p = loadProfile(id);
      assert.equal(p.id, id, `${id} 的 id 应为自身`);
      assert.ok(typeof p.displayName === "string" && p.displayName.length > 0, `${id} 应有 displayName`);
      for (const sw of ["stalledFuse", "budgetGate", "reasoningWatch", "evidenceGate", "emotionFilter", "approvalGate", "redlineGate"]) {
        assert.equal(typeof p[sw], "object", `${id} 缺开关 ${sw}`);
        assert.equal(typeof p[sw].enabled, "boolean", `${id}.${sw}.enabled 应为 boolean`);
      }
    }
  });

  test("验收 2：未匹配 modelId 走 default", () => {
    for (const raw of ["", null, undefined, "no-such-model-xyz", "qwen-unknown-9b"]) {
      const p = loadProfile(raw);
      assert.equal(p.id, "default", `${String(raw)} 应落 default`);
      assert.match(p.profileSource, /^default:/);
    }
    // 归一化：大小写/空白不影响命中
    assert.equal(loadProfile("  DeepSeek-Flash  ").id, "deepseek-flash");
    assert.equal(loadProfile("gpt-astra-v9").id, "gpt-astra", "前缀应命中");
  });

  test("验收 3：同请求在 flash(evidenceGate on) 与 astra(evidenceGate off) 下决策不同", async () => {
    const flash = await decide({ ...UNEVIDENCED, modelId: "deepseek-flash" });
    const astra = await decide({ ...UNEVIDENCED, modelId: "gpt-astra" });
    console.log("flash:", flash.decision, "L" + flash.layer, "| skipped:", JSON.stringify(flash.skipped));
    console.log("astra:", astra.decision, "L" + astra.layer, "| skipped:", JSON.stringify(astra.skipped));
    assert.equal(flash.decision, "deny", "flash 的 evidenceGate 开启 → 未取证应 deny");
    assert.equal(flash.layer, "4");
    assert.equal(astra.decision, "allow", "astra 的 evidenceGate 关闭 → L4 跳过 → 放行");
    assert.equal(astra.layer, "6");
    assert.notEqual(flash.decision, astra.decision, "同一请求在不同画像下决策必须不同");
  });

  test("验收 4：跳过的层不出现在 active 里", async () => {
    const r = await decide({ ...UNEVIDENCED, modelId: "gpt-astra" });
    const active = activeFromTrace(r.trace).map((s) => s.layer);
    const skipped = skippedFromTrace(r.trace).map((s) => s.layer);
    console.log("active:", JSON.stringify(active), "| skipped:", JSON.stringify(skipped));
    assert.equal(active.includes("4"), false, "L4 已跳过，不得出现在 active");
    assert.ok(skipped.includes("4"), "L4 应出现在 skipped");
    // 跳过的层必须在 trace 里带 skip 标记
    const l4 = r.trace.find((s) => s.layer === "4");
    assert.equal(l4.decision, "skip");
    assert.match(l4.reason, /evidenceGate/);
  });

  test("层开关判定：L1 拆子开关、L0/L5/L6 不受画像控制", () => {
    const flash = loadProfile("deepseek-flash");
    const astra = loadProfile("gpt-astra");
    assert.equal(LAYER_SWITCHES["1-fuse"], "stalledFuse");
    assert.equal(LAYER_SWITCHES["1-budget"], "budgetGate");
    for (const k of ["0", "5", "6"]) assert.equal(LAYER_SWITCHES[k], null, `L${k} 应无画像开关`);
    assert.equal(layerEnabled(flash, "4"), true);
    assert.equal(layerEnabled(astra, "4"), false);
    assert.equal(layerEnabled(astra, "1-fuse"), false, "astra 的 stalledFuse 关闭");
    assert.equal(layerEnabled(null, "2"), true, "无画像时应保守启用");
    assert.equal(layerEnabled({}, "2"), true, "画像缺字段时应保守启用");
  });

  test("未实现开关：只登记、进 skipped、不参与执行", async () => {
    const flash = loadProfile("deepseek-flash");
    const sw = unimplementedSwitches(flash);
    assert.equal(sw.length, 2);
    assert.deepEqual(sw.map((s) => s.name).sort(), ["emotionFilter", "reasoningWatch"]);
    assert.ok(sw.every((s) => s.reason === "no engine implementation, TODO"));

    const r = await decide({ tool: "Read", command: "", purpose: "查看", scope: "只读", modelId: "deepseek-flash" });
    const skipped = skippedFromTrace(r.trace);
    for (const name of ["reasoningWatch", "emotionFilter"]) {
      const hit = skipped.find((s) => s.layer === name);
      assert.ok(hit, `${name} 应出现在 skipped`);
      assert.equal(hit.reason, "no engine implementation, TODO");
    }
  });

  test("回归：不传 profile 时行为与 3.0.4 一致（全部层启用、无 skip 追加）", async () => {
    const r = await checkEligibility({
      tool: "Write",
      command: "rm -f ./tmp/a.txt",
      target: "./tmp/a.txt",
      purpose: "清理临时文件",
      scope: "仅 ./tmp/a.txt",
      state: { readSet: {} },
    });
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "4");
    assert.deepEqual(r.trace.map((s) => s.layer), ["0", "1", "2", "3", "4"]);
    assert.equal(r.trace.some((s) => s.decision === "skip"), false, "未传 profile 不应出现 skip");
  });

  test("审计带 skipped：跳过信息进入 audit 的 trace 字段", async () => {
    const calls = [];
    const r = await decide({
      ...UNEVIDENCED,
      modelId: "gpt-astra",
      audit: (row) => calls.push(row),
      redlines: [],
    });
    assert.equal(r.decision, "allow");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "grant");
    assert.ok(Array.isArray(calls[0].skipped), "audit 记录应含 skipped 数组");
    assert.ok(calls[0].skipped.some((s) => s.layer === "4"), "L4 应写进审计 skipped");
  });
});
