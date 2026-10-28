import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-10-28：熔断太容易的两条根因回归锁。
//  ① 回合级计数被当会话累计 → 到 200 后每个有效调用都重新熔断，换回合也解不开；
//  ② 闸门 deny 被当"无效调用" → 连拦 3 个文件就熔断。
const AUDIT_TMP = join(tmpdir(), `fg-fusebudget-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { postProgressListener } = await import("../src/dsh/postProgress.mjs");
const { preStepListener } = await import("../src/dsh/seams/pre-step.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");
const { STALL_FUSE, BUDGET_CAP } = await import("../src/core/constants.mjs");

const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkExec = (sid, name, args) => ({
  sessionId: sid,
  agent: { session: { header: { id: sid, cwd: process.cwd() } } },
  name,
  arguments: args,
});
const withState = (sid, patch = {}) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
};

const turnOf = (sid, turn, text = "继续") => ({
  agent: { session: { header: { id: sid, cwd: process.cwd() } } },
  messages: [{ role: "user", content: text }],
  turn,
  step: 1,
});

describe("熔断预算：回合级计数 + 闸门拒绝不计停滞", () => {
  test("换回合清零 effectiveCalls/invCalls，并解除 fused", async () => {
    const sid = `fusebudget-reset-${process.pid}`;
    withState(sid, {
      turnCount: 3,
      fused: true,
      effectiveCalls: BUDGET_CAP + 1,
      invCalls: 268,
      invWarned: true,
      lastTurn: 1,
      taskBudget: 200,
    });
    const l = preStepListener({ warn: noop });
    await l(turnOf(sid, 2), pass);
    const s = loadState(statePath(sid));
    assert.equal(s.effectiveCalls, 0, "换回合后执行池计数必须归零（否则硬上限永不解除）");
    assert.equal(s.invCalls, 0, "换回合后侦查池计数同样归零");
    assert.equal(s.invWarned, false);
    assert.equal(s.fused, false, "非停止令的熔断应随回合重置解除");
    assert.equal(s.lastTurn, 2);
    rmSync(statePath(sid), { force: true });
  });

  test("同一回合内不清熔断（回合级状态语义）", async () => {
    const sid = `fusebudget-sameturn-${process.pid}`;
    withState(sid, { fused: true, lastTurn: 7, effectiveCalls: 5, stalledStreak: 2 });
    const l = preStepListener({ warn: noop });
    await l(turnOf(sid, 7), pass);
    const s = loadState(statePath(sid));
    assert.equal(s.fused, true, "同一回合内熔断不得被 pre-step 自己清掉");
    assert.equal(s.effectiveCalls, 5, "同一回合内计数不清零");
    rmSync(statePath(sid), { force: true });
  });

  test("闸门 deny 不计入 stalledStreak（被拦 ≠ 空转）", async () => {
    const sid = `fusebudget-deny-${process.pid}`;
    withState(sid, { stalledStreak: 0 });
    const l = postProgressListener({ warn: noop });
    const exec = mkExec(sid, "edit", { file_path: "x.md" });
    for (let i = 0; i < STALL_FUSE + 2; i += 1) {
      await l(exec, { error: "focus-guard-native: 命中绝对红线", isError: true }, pass);
    }
    const s = loadState(statePath(sid));
    assert.notEqual(s.fused, true, "连续被闸拒绝不得触发熔断");
    assert.equal(s.stalledStreak || 0, 0, "deny 对停滞记中性");
    rmSync(statePath(sid), { force: true });
  });

  test("真失败仍按 STALL_FUSE 熔断（不因上面的豁免而失守）", async () => {
    const sid = `fusebudget-fail-${process.pid}`;
    withState(sid, { stalledStreak: 0 });
    const l = postProgressListener({ warn: noop });
    const exec = mkExec(sid, "edit", { file_path: "y.md" });
    for (let i = 0; i < STALL_FUSE; i += 1) {
      await l(exec, { error: "boom", isError: true }, pass);
    }
    const s = loadState(statePath(sid));
    assert.equal(s.fused, true, `连续 ${STALL_FUSE} 次真失败应熔断`);
    rmSync(statePath(sid), { force: true });
  });
});
