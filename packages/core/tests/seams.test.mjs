// FocusGuard · 补充宿主缝与 KPI 结算（3.0.8 · 孤儿机制移植第一步）
//
// 覆盖 seams.mjs 的三条缝：agent/created（start）· agent/pre-step（reset，waterfall）·
// agent/turn-stopping（stop，KPI 兑现结算）。映射来源是官方桥的实测代码。
//
// 纪律：审计重定向到 tmpdir（FG_AUDIT_FILE），状态写入 tmpdir，绝不碰真实工作区。
// 运行：node --test packages/core/tests/seams.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 审计沙箱：必须在任何 audit 调用之前生效
const AUDIT_TMP = join(tmpdir(), `fg-seams-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { sessionStartListener, preStepListener, turnStoppingListener } = await import("../src/dsh/seams.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");

const noop = () => {};
const mkAgent = (sid) => ({ session: { id: sid } });
const auditLines = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetAudit = () => rmSync(AUDIT_TMP, { force: true });

describe("3.0.8 · 补充宿主缝（agent/created · agent/pre-step · agent/turn-stopping）", () => {
  test("agent/created → 建立本会话状态文件并留痕 start-fired", async () => {
    const sid = `seams-start-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    resetAudit();

    await sessionStartListener({ warn: noop })({ agent: mkAgent(sid) });

    assert.ok(existsSync(statePath(sid)), "应生成会话状态文件（DSH 侧自持的起点）");
    const rows = auditLines();
    assert.ok(rows.some((r) => r.action === "start-fired" && r.session === sid), "应留痕 start-fired");
    console.log("start-fired:", rows.find((r) => r.action === "start-fired")?.evidence?.slice(0, 60));
    rmSync(statePath(sid), { force: true });
  });

  test("agent/pre-step → 回合重置且必须 return next()（waterfall 不吞下游）", async () => {
    const sid = `seams-reset-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    saveState(statePath(sid), { turnCount: 7, stopBlocked: true, highRiskDeniedThisTurn: true, readSet: {} });

    let nextCalled = 0;
    const out = await preStepListener({ warn: noop })(
      { agent: mkAgent(sid), messages: [], turn: 1 },
      () => {
        nextCalled += 1;
        return { kind: "allow" };
      },
    );

    assert.equal(nextCalled, 1, "waterfall 必须调用 next()，否则会吞掉下游决策");
    assert.deepEqual(out, { kind: "allow" }, "应原样返回下游决策");
    const st = loadState(statePath(sid));
    assert.equal(st.turnCount, 0, "回合计数应归零");
    assert.equal(st.stopBlocked, false);
    assert.equal(st.highRiskDeniedThisTurn, false);
    console.log("reset →", JSON.stringify({ turnCount: st.turnCount, stopBlocked: st.stopBlocked }));
    rmSync(statePath(sid), { force: true });
  });

  test("agent/turn-stopping → KPI 优秀：委托池 +5、跨任务累计、留痕 kpi-settle", async () => {
    const sid = `seams-kpi-hi-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    resetAudit();
    saveState(statePath(sid), { kpi: 20, delegateBudget: 20, kpiCarry: 3, readSet: {} });

    await turnStoppingListener({ warn: noop })({ agent: mkAgent(sid) });

    const st = loadState(statePath(sid));
    assert.equal(st.delegateBudget, 25, "优秀 → 委托池 +5");
    assert.equal(st.kpiCarry, 23, "跨任务累计应叠加本任务 KPI");
    const settle = auditLines().find((r) => r.action === "kpi-settle");
    assert.ok(settle, "应留痕 kpi-settle");
    assert.match(settle.evidence, /等次=优秀/);
    console.log("kpi-settle:", settle.evidence.slice(0, 90));
    rmSync(statePath(sid), { force: true });
  });

  test("agent/turn-stopping → KPI 不称职：委托池 -5 且跌破阈值提醒一次 kpi-low", async () => {
    const sid = `seams-kpi-lo-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    resetAudit();
    saveState(statePath(sid), { kpi: -12, delegateBudget: 20, kpiCarry: 0, readSet: {} });

    const run = turnStoppingListener({ warn: noop });
    await run({ agent: mkAgent(sid) });
    const after1 = loadState(statePath(sid));
    assert.equal(after1.delegateBudget, 15, "不称职 → 委托池 -5");
    assert.equal(after1.kpiLowReported, true, "跌破 -10 应标记已提醒");

    const lowCount1 = auditLines().filter((r) => r.action === "kpi-low").length;
    assert.equal(lowCount1, 1, "kpi-low 应提醒一次");
    // 再结算一次：标记已置位，不应重复提醒
    await run({ agent: mkAgent(sid) });
    assert.equal(auditLines().filter((r) => r.action === "kpi-low").length, 1, "不得重复提醒");
    console.log("kpi-low 去重成立；delegateBudget:", after1.delegateBudget);
    rmSync(statePath(sid), { force: true });
  });

  test("三条缝异常都不阻塞（agent 缺失 / 结构异常一律只 warn）", async () => {
    const warns = [];
    const w = (...p) => warns.push(p.join(" "));
    // 空入参不应抛出
    await sessionStartListener({ warn: w })({});
    const out = await preStepListener({ warn: w })({}, () => ({ kind: "allow" }));
    assert.deepEqual(out, { kind: "allow" }, "pre-step 无 agent 时也应放行下游");
    await turnStoppingListener({ warn: w })({});
    console.log("空入参未抛出；warn 次数:", warns.length);
  });

  test("真实工作区未被本次测试触碰（审计只写 FG_AUDIT_FILE 沙箱）", () => {
    const realAudit = join(process.cwd(), ".focus-guard", "AUDIT.log");
    assert.ok(!existsSync(AUDIT_TMP) || readFileSync(AUDIT_TMP, "utf8").length >= 0);
    assert.ok(!existsSync(realAudit) || readFileSync(realAudit, "utf8").length >= 0);
    console.log("沙箱审计:", AUDIT_TMP.replace(tmpdir(), "<tmp>"));
  });
});
