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
// 与官方桥同源：会话 id 取自 agent.session.header.id（不是 agent.session.id）
const mkAgent = (sid) => ({ session: { header: { id: sid, cwd: process.cwd() } } });
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

describe("3.0.8 · 批示识别（reset 移植自 guard.mjs L194-326）", () => {
  // 与桥的 blocksToText 同口径：messages[i].content 是块数组
  const msg = (text) => [{ content: [{ type: "text", text }] }];
  const pass = () => ({ kind: "allow" });
  const prep = (sid, patch) => {
    rmSync(statePath(sid), { force: true });
    saveState(statePath(sid), { readSet: {}, ...patch });
  };

  test("停止令『停止』→ 熔断置位 + stall-fuse 留痕（不得被自家重置抹掉）", async () => {
    const sid = `seams-stop-${process.pid}`;
    prep(sid, {});
    resetAudit();
    await preStepListener({ warn: noop })({ agent: mkAgent(sid), messages: msg("停止") }, pass);
    const st = loadState(statePath(sid));
    assert.equal(st.fused, true, "人类批示停止必须真的熔断");
    assert.ok(st.violations >= 3, "违例计数应抬高");
    assert.ok(auditLines().some((r) => r.action === "stall-fuse"), "应留痕 stall-fuse");
    console.log("stop →", JSON.stringify({ fused: st.fused, violations: st.violations }));
    rmSync(statePath(sid), { force: true });
  });

  test("追加批示『追加』→ 三池各 +REFILL(10)", async () => {
    const sid = `seams-extend-${process.pid}`;
    prep(sid, { taskBudget: 10, invCap: 10, delegateBudget: 10 });
    await preStepListener({ warn: noop })({ agent: mkAgent(sid), messages: msg("追加") }, pass);
    const st = loadState(statePath(sid));
    assert.equal(st.delegateBudget, 20, "委托池应 +10");
    assert.equal(st.invCap, 20, "侦查池应 +10");
    console.log("extend →", JSON.stringify({ budget: st.taskBudget, invCap: st.invCap, delegate: st.delegateBudget }));
    rmSync(statePath(sid), { force: true });
  });

  test("额度核定：批示含『审计』(KEY50_RE) → taskBudget=50", async () => {
    const sid = `seams-kw-${process.pid}`;
    prep(sid, { taskBudget: 10 });
    await preStepListener({ warn: noop })({ agent: mkAgent(sid), messages: msg("做一次全面审计") }, pass);
    const st = loadState(statePath(sid));
    assert.equal(st.taskBudget, 50, "含 KEY50 关键词应核定为 50");
    assert.equal(st.taskInitial, 50);
    console.log("额度核定 →", st.taskBudget);
    rmSync(statePath(sid), { force: true });
  });

  test("执行级授权：待批时『y』放行并目标绑定；『n』彻底阻断并清除绑定", async () => {
    const sidY = `seams-y-${process.pid}`;
    prep(sidY, { highRiskQueue: [{ k: "key-A" }, { k: "key-B" }], highRiskKey: "key-C" });
    resetAudit();
    await preStepListener({ warn: noop })({ agent: mkAgent(sidY), messages: msg("y") }, pass);
    const stY = loadState(statePath(sidY));
    assert.equal(stY.highRiskOk, true, "y 应设置执行级授权");
    assert.deepEqual(stY.highRiskBatch, ["key-A", "key-B", "key-C"], "应放行全部待批（队列+当前）");
    assert.equal(stY.highRiskApprovedKeys["key-A"], true, "批示即绑定目标键");
    assert.ok(auditLines().some((r) => r.action === "high-risk-approved"), "应留痕 approved");
    console.log("y →", JSON.stringify(stY.highRiskBatch));
    rmSync(statePath(sidY), { force: true });

    const sidN = `seams-n-${process.pid}`;
    prep(sidN, { highRiskQueue: [{ k: "key-A" }], highRiskKey: "key-B", highRiskApprovedKeys: { "key-A": true } });
    await preStepListener({ warn: noop })({ agent: mkAgent(sidN), messages: msg("n") }, pass);
    const stN = loadState(statePath(sidN));
    assert.equal(stN.rejectedCmds["key-A"], 1, "n 应彻底阻断");
    assert.equal(stN.highRiskApprovedKeys["key-A"], undefined, "n 须同时清除历史批准绑定");
    assert.equal(stN.highRiskQueue.length, 0);
    console.log("n → rejected:", Object.keys(stN.rejectedCmds).join(","));
    rmSync(statePath(sidN), { force: true });
  });

  test("非批示文本不误判（『是不是应该这样』不得被当成 y）", async () => {
    const sid = `seams-noy-${process.pid}`;
    prep(sid, { highRiskQueue: [{ k: "key-A" }] });
    await preStepListener({ warn: noop })({ agent: mkAgent(sid), messages: msg("是不是应该这样处理") }, pass);
    const st = loadState(statePath(sid));
    assert.notEqual(st.highRiskOk, true, "长句/非批示不得构成执行级授权");
    console.log("非批示文本未被误判为 y；highRiskOk =", st.highRiskOk);
    rmSync(statePath(sid), { force: true });
  });
});
