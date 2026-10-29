import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WATCHED, SELF_NAME, judgeOrdering, probeHookOrdering } from "../src/dsh/hookOrder.mjs";

describe("钩子顺序自检", () => {
  test("结构锚点：必须盯着 tools/pre-execute（FG 的主拦截缝）", () => {
    assert.ok(WATCHED.includes("tools/pre-execute"), "pre-execute 是 FG 的核心拦截缝，不能漏");
    assert.equal(SELF_NAME, "focus-guard", "参与者名字变了会让自检永远判不到自己");
  });

  test("无协调器 → uncontrolled（顺序由注册时机决定）", () => {
    const v = judgeOrdering({ hasService: false });
    assert.equal(v.state, "uncontrolled");
    assert.deepEqual(v.hooks, []);
    assert.match(v.message, /注册时机/);
  });

  test("协调器在、FG 不在参与者里 → controlled-not-participant（预期状态）", () => {
    const v = judgeOrdering({
      hasService: true,
      plans: { "tools/pre-execute": { front: ["memory-inject", "other-guard"], back: [] } },
    });
    assert.equal(v.state, "controlled-not-participant");
    assert.match(v.message, /预期状态/);
  });

  test("FG 出现在 front → participant，且报出位置（这是接错了的信号）", () => {
    const v = judgeOrdering({
      hasService: true,
      plans: { "tools/pre-execute": { front: ["memory-inject", SELF_NAME], back: [] } },
    });
    assert.equal(v.state, "participant");
    assert.deepEqual(v.hooks, ["tools/pre-execute:front#2"]);
    assert.match(v.message, /deny 不会生效/);
  });

  test("FG 出现在 back 也要报（back 更晚，同样承载不了 deny）", () => {
    const v = judgeOrdering({
      hasService: true,
      plans: { "tools/pre-execute": { front: [], back: [SELF_NAME] } },
    });
    assert.equal(v.state, "participant");
    assert.deepEqual(v.hooks, ["tools/pre-execute:back#1"]);
  });

  test("拿不到 plan 的钩子跳过，不误判成 participant", () => {
    const v = judgeOrdering({ hasService: true, plans: { "tools/pre-execute": null } });
    assert.equal(v.state, "controlled-not-participant");
  });

  test("probeHookOrdering：ctx.get 抛错时降级为 uncontrolled，不向上冒泡", () => {
    const ctx = {
      get() {
        throw new Error("cannot get property without inject");
      },
    };
    const v = probeHookOrdering(ctx);
    assert.equal(v.state, "uncontrolled");
  });

  test("probeHookOrdering：plan 对未控制的钩子抛错时跳过该钩子", () => {
    const ctx = {
      get: () => ({
        plan() {
          throw new Error("HookControlError: hook not controlled");
        },
      }),
    };
    const v = probeHookOrdering(ctx);
    assert.equal(v.state, "controlled-not-participant");
  });

  test("probeHookOrdering：正常协调器读出真实位置", () => {
    const ctx = {
      get: () => ({
        plan(hook, phase) {
          if (hook !== "tools/pre-execute") throw new Error("not controlled");
          return phase === "front" ? ["a", SELF_NAME] : [];
        },
      }),
    };
    const v = probeHookOrdering(ctx);
    assert.equal(v.state, "participant");
    assert.deepEqual(v.hooks, ["tools/pre-execute:front#2"]);
  });

  test("无 ctx / ctx 无 get → uncontrolled（不抛）", () => {
    assert.equal(probeHookOrdering(null).state, "uncontrolled");
    assert.equal(probeHookOrdering({}).state, "uncontrolled");
  });
});
