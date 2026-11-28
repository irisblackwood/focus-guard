import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-11-28：回合级状态被按「每步」重置的回归锁。
//
// 背景（session-c00d686c，2107 行真实日志）：`agent/pre-step` 每个 step 都触发，
// 而 saveResetState 把语义为「本回合 / 本任务」的字段一并按步清空，等于把执法骨架逐条关掉：
//   readSet      → Read 记的账下一步就没了，24 条 deny 全落「未取证」
//   editedFiles  → blast-radius 阈值 6 从未触发（2107 行 0 条）
//   kpiScolded   → 同一回合反复扣分（turn 100 的 step 3 与 step 12 各 -5）
//   delegated    → 「已委派过」每步丢失
//   violations   → penalize 三级递进（2/3/5）永不成立
//   turnCount    → stopPolicy「本回合 ≥N 步」永不成立
// 这批字段若被改回每步重置，本文件的断言必须红。
const AUDIT_TMP = join(tmpdir(), `fg-turnscope-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { preStepListener } = await import("../src/dsh/seams/pre-step.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");

const noop = () => {};
const pass = () => ({ kind: "allow" });

const mkTurn = (sid, turn, step, text = "继续") => ({
  agent: { session: { header: { id: sid, cwd: process.cwd() } } },
  messages: [{ role: "user", content: text }],
  turn,
  step,
});

const withState = (sid, patch = {}) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
};

const auditLines = () => {
  try {
    return readFileSync(AUDIT_TMP, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** 11 个回合级字段在同一回合内的存活基线。 */
const TURN_SCOPED = {
  turnCount: 4,
  violations: 3,
  forcedInvestigate: true,
  probation: true,
  stopBlocked: true,
  randomFusePending: true,
  readSet: { "E:/x/a.mjs": 1 },
  editedFiles: { "E:/x/a.mjs": 1 },
  kpiScolded: { search: true },
  delegated: true,
  kpiDelegatedAwarded: true,
};

describe("回合级状态：同一回合内跨 step 存活，换回合才清", () => {
  test("同回合 step 2→3：11 个字段全部保留", async () => {
    const sid = `turnscope-keep-${process.pid}`;
    withState(sid, { lastTurn: 9, ...TURN_SCOPED });
    const l = preStepListener({ warn: noop });
    await l(mkTurn(sid, 9, 3), pass);
    const s = loadState(statePath(sid));
    for (const [k, v] of Object.entries(TURN_SCOPED)) {
      assert.deepEqual(s[k], v, `${k} 属回合级，同一回合内不得被 pre-step 清掉`);
    }
    rmSync(statePath(sid), { force: true });
  });

  test("换回合（9→10）：11 个字段全部清空", async () => {
    const sid = `turnscope-clear-${process.pid}`;
    withState(sid, { lastTurn: 9, ...TURN_SCOPED });
    const l = preStepListener({ warn: noop });
    await l(mkTurn(sid, 10, 1), pass);
    const s = loadState(statePath(sid));
    assert.equal(s.turnCount, 0);
    assert.equal(s.violations, 0);
    assert.equal(s.forcedInvestigate, false);
    assert.equal(s.probation, false);
    assert.equal(s.stopBlocked, false);
    assert.equal(s.randomFusePending, false);
    assert.deepEqual(s.readSet, {});
    assert.deepEqual(s.editedFiles, {});
    assert.deepEqual(s.kpiScolded, {});
    assert.equal(s.delegated, false);
    assert.equal(s.kpiDelegatedAwarded, false);
    rmSync(statePath(sid), { force: true });
  });

  test("readSet 跨 step 保留 → 取证闸不会「读了还算没读」", async () => {
    const sid = `turnscope-read-${process.pid}`;
    withState(sid, { lastTurn: 3, readSet: { "E:/x/target.mjs": 1 } });
    const l = preStepListener({ warn: noop });
    await l(mkTurn(sid, 3, 5), pass);
    await l(mkTurn(sid, 3, 6), pass);
    const s = loadState(statePath(sid));
    assert.deepEqual(s.readSet, { "E:/x/target.mjs": 1 }, "取证记录必须活到回合结束");
    rmSync(statePath(sid), { force: true });
  });
});

describe("批示识别按回合执行，不按步", () => {
  test("同一回合内 budget-extend 只加一次额度", async () => {
    const sid = `turnscope-budget-${process.pid}`;
    withState(sid, { lastTurn: 4, taskBudget: 10 });
    const l = preStepListener({ warn: noop });
    await l(mkTurn(sid, 5, 1, "追加额度"), pass);
    const once = loadState(statePath(sid)).taskBudget;
    await l(mkTurn(sid, 5, 2, "追加额度"), pass);
    await l(mkTurn(sid, 5, 3, "追加额度"), pass);
    const thrice = loadState(statePath(sid)).taskBudget;
    assert.equal(thrice, once, "同一句批示在同一回合内不得反复加额度");
    assert.ok(once > 10, "换回合（首次）时应真的加了一次");
    rmSync(statePath(sid), { force: true });
  });

  test("同一回合内 goal-preauth 只留一行", async () => {
    const sid = `turnscope-goal-${process.pid}`;
    withState(sid, { lastTurn: 1 });
    const l = preStepListener({ warn: noop });
    await l(mkTurn(sid, 2, 1, "做完就推送"), pass);
    await l(mkTurn(sid, 2, 2, "做完就推送"), pass);
    await l(mkTurn(sid, 2, 3, "做完就推送"), pass);
    const rows = auditLines().filter((x) => x.includes("goal-preauth") && x.includes(sid));
    assert.equal(rows.length, 1, `同一回合 3 步应只记 1 行 goal-preauth，实际 ${rows.length}`);
    rmSync(statePath(sid), { force: true });
  });

  test("特赦标记不被同回合后续 step 覆写", async () => {
    const sid = `turnscope-mercy-${process.pid}`;
    withState(sid, { lastTurn: 1 });
    const l = preStepListener({ warn: noop });
    await l(mkTurn(sid, 1, 1, "特赦"), pass);
    const first = loadState(statePath(sid)).mercy;
    await l(mkTurn(sid, 1, 2, "特赦"), pass);
    assert.equal(loadState(statePath(sid)).mercy, first, "特赦必须活到回合结束");
    rmSync(statePath(sid), { force: true });
  });
});
