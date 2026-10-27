// FocusGuard · 熔断生命周期（2026-10-27）
//
// 病根（实测 turn 128 / 130，session-7bd3f3fb）：
//   `agent/pre-step` **每个 step 都触发**，而回合重置里无条件写 `fused: stopOrdered`
//   → 熔断在下一步就被清掉。日志证据：step 19 硬上限熔断，step 20 起 eff 仍 200→206、
//   inv 787→793，白走 16 步；turn 130 更甚，18 步。
//   设计意图本就是"回合级状态"（seams.mjs 的 residue-check 已把 fused 列为待清残留），
//   所以这是实现与意图不符。
//
// 本组锁两件事：
//   ① 熔断只在**换回合**（turn 变化）时重置；同一回合内必须保留。
//   ② 熔断期间系统提示注入 `focus-guard-fuse`（此前只写 warn，模型完全看不见）。
//
// 纪律：审计与状态都写 tmpdir；不碰真实工作区。
// 运行：node --test packages/core/tests/fuse-lifecycle.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORK = mkdtempSync(join(tmpdir(), "fg-fuselife-"));
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_STATUS_FILE = join(WORK, "status.json");

const { preStepListener } = await import("../src/dsh/seams.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");

const mkAgent = (sid) => ({ session: { header: { id: sid, cwd: process.cwd() } } });
const pass = () => ({ kind: "allow" });

describe("熔断生命周期", () => {
  test("f1. 同一回合内 pre-step 不得清掉熔断（否则熔断只活一步）", async () => {
    const sid = `fuse-life-same-${process.pid}`;
    const f = statePath(sid);
    saveState(f, { readSet: {}, fused: true, lastTurn: 7, effectiveCalls: 200 });
    const l = preStepListener({ warn: () => {} });

    // 同一 turn=7 的第 2、3 步：熔断必须保留
    await l({ agent: mkAgent(sid), messages: [], turn: 7, step: 2 }, pass);
    assert.equal(loadState(f).fused, true, "同回合第 2 步：熔断被清了（这就是 turn 128 白走 16 步的根因）");
    await l({ agent: mkAgent(sid), messages: [], turn: 7, step: 3 }, pass);
    assert.equal(loadState(f).fused, true, "同回合第 3 步：熔断仍应保留");
    assert.equal(loadState(f).lastTurn, 7, "应记下当前回合号");
    rmSync(f, { force: true });
  });

  test("f2. 换回合（turn 变化）才重置熔断", async () => {
    const sid = `fuse-life-new-${process.pid}`;
    const f = statePath(sid);
    saveState(f, { readSet: {}, fused: true, lastTurn: 7 });
    const l = preStepListener({ warn: () => {} });
    await l({ agent: mkAgent(sid), messages: [], turn: 8, step: 1 }, pass);
    assert.equal(loadState(f).fused, false, "换回合应重置熔断（回合级状态）");
    assert.equal(loadState(f).lastTurn, 8);
    rmSync(f, { force: true });
  });

  test("f3. 人类停止令在新回合仍置熔断（stopOrdered 不被绕过）", async () => {
    const sid = `fuse-life-stop-${process.pid}`;
    const f = statePath(sid);
    saveState(f, { readSet: {}, fused: false, lastTurn: 1 });
    const l = preStepListener({ warn: () => {} });
    const messages = [{ role: "user", content: [{ type: "text", text: "停止" }] }];
    await l({ agent: mkAgent(sid), messages, turn: 2, step: 1 }, pass);
    assert.equal(loadState(f).fused, true, "人类停止令必须置熔断");
    rmSync(f, { force: true });
  });

  test("f4. 熔断期间系统提示注入 focus-guard-fuse；未熔断不注入", async () => {
    const sid = `fuse-life-prompt-${process.pid}`;
    const f = statePath(sid);
    const mod = await import("../src/dsh/index.js");
    const handlers = new Map();
    const ctx = {
      on: (event, fn) => handlers.set(event, fn),
      tools: { register: () => {}, guard: () => {}, schemas: () => [] },
      logger: { warn: () => {} },
      effect: () => {},
    };
    mod.apply(ctx);

    const keys = [...handlers.keys()].filter((n) => n.startsWith("system-prompt/assemble"));
    assert.ok(keys.length > 0, "应注册装配缝");
    const listener = handlers.get(keys[keys.length - 1]);
    const call = () =>
      listener({ sections: [] }, { agent: mkAgent(sid) }, async () => ({ sections: [] }));

    saveState(f, { readSet: {}, fused: true });
    const on = await call();
    const onNames = (on && on.sections ? on.sections : []).map((s) => s.name);
    assert.ok(onNames.includes("focus-guard-fuse"), `熔断期间应注入告知段，实际：${onNames.join(",") || "(空)"}`);
    const notice = on.sections.find((s) => s.name === "focus-guard-fuse").text;
    assert.match(notice, /已终止/, "文案要说清任务已终止");
    assert.match(notice, /三行降级方案/, "文案要给出收尾动作");

    saveState(f, { readSet: {}, fused: false });
    const off = await call();
    const offNames = (off && off.sections ? off.sections : []).map((s) => s.name);
    assert.ok(!offNames.includes("focus-guard-fuse"), `未熔断不得注入，实际：${offNames.join(",") || "(空)"}`);
    rmSync(f, { force: true });
    rmSync(WORK, { recursive: true, force: true });
  });
});
