// FocusGuard · 审计位置元数据（turn / step）与熔断浪费（2026-10-19 人类批示）
//
// 覆盖四件事：
//   ① provider 装配后，所有审计行自动带 turn/step（写入器单点注入，不用逐个改调用点）
//   ② 行里显式给的 turn/step 不被覆盖；未装配 provider 时不添加字段（zcode 路径行为不变）
//   ③ 熔断点识别 → 回合结束结算 `fuse-waste`（wasted = 回合末 step − 熔断 step）
//   ④ **按会话独立计数**：两个会话的 step 各自从 1 起，互不相加；换回合作废上一回合熔断点
//
// 纪律：审计重定向 tmpdir（FG_AUDIT_FILE），状态文件也在 tmpdir，绝不碰真实工作区。
// 运行：node --test packages/core/tests/trace-meta.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 审计沙箱：必须在任何 audit 调用之前生效
const AUDIT_TMP = join(tmpdir(), `fg-tracemeta-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { appendAudit } = await import("../src/core/audit-writer.mjs");
const { installTraceMeta, noteTracePosition, recordFuseWaste, currentPosition, resetTraceMeta } = await import(
  "../src/dsh/traceMeta.mjs"
);
const { preStepListener } = await import("../src/dsh/seams.mjs");
const { statePath } = await import("../src/core/state.mjs");
const { rmSync: rm2 } = await import("node:fs");

// 与官方桥同源：会话 id 取自 agent.session.header.id
const mkAgent = (sid) => ({ session: { header: { id: sid, cwd: process.cwd() } } });
const auditLines = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const resetAudit = () => rmSync(AUDIT_TMP, { force: true });

describe("位置元数据 · turn/step（审计写入器单点注入）", () => {
  test("h1. 装配 provider 后，审计行自动带 turn/step", () => {
    resetTraceMeta();
    installTraceMeta();
    resetAudit();
    noteTracePosition(mkAgent("tm-h1"), 3, 2);
    appendAudit({ ts: new Date().toISOString(), session: "tm-h1", action: "deny", evidence: "x" });
    const [row] = auditLines();
    console.log("[h1] row =", JSON.stringify({ turn: row.turn, step: row.step }));
    assert.equal(row.turn, 3, "应注入 turn");
    assert.equal(row.step, 2, "应注入 step");
  });

  test("h2. 行里显式给的值优先；未装配 provider 时不添加字段", () => {
    resetTraceMeta();
    resetAudit();
    appendAudit({ ts: new Date().toISOString(), session: "tm-h2", action: "deny", turn: 9, step: 9 });
    let [row] = auditLines();
    assert.equal(row.turn, 9, "无 provider 时行里显式值原样保留");
    assert.equal(row.step, 9);

    installTraceMeta();
    noteTracePosition("tm-h2", 1, 1);
    resetAudit();
    appendAudit({ ts: new Date().toISOString(), session: "tm-h2", action: "deny", turn: 9, step: 7 });
    [row] = auditLines();
    assert.equal(row.turn, 9, "显式 turn 不应被 provider 覆盖");
    assert.equal(row.step, 7, "显式 step 不应被 provider 覆盖");
  });

  test("h3. pre-step 缝把 {turn, step} 记进位置表（宿主唯一来源）", async () => {
    resetTraceMeta();
    installTraceMeta();
    const sid = `tm-h3-${process.pid}`;
    rm2(statePath(sid), { force: true });
    await preStepListener({ warn: () => {} })(
      { agent: mkAgent(sid), messages: [], turn: 4, step: 2 },
      () => ({ kind: "allow" }),
    );
    assert.equal(currentPosition(sid)?.turn, 4);
    assert.equal(currentPosition(sid)?.step, 2);
    rm2(statePath(sid), { force: true });
  });
});

describe("熔断浪费 · 按会话独立计数", () => {
  test("h4. 本回合真熔断 → 结算 fuse-waste，wasted = 回合末 step − 熔断 step", () => {
    resetTraceMeta();
    installTraceMeta();
    resetAudit();
    noteTracePosition("tm-h4", 5, 1);
    appendAudit({ ts: new Date().toISOString(), session: "tm-h4", action: "stall-fuse", level: 3, evidence: "连续 3 次无效调用" });
    noteTracePosition("tm-h4", 5, 7);
    const report = recordFuseWaste("tm-h4");
    console.log("[h4] report =", JSON.stringify(report));
    assert.equal(report.wastedSteps, 6, "熔断点 step 1 → 回合末 step 7 = 浪费 6 步");
    const row = auditLines().find((r) => r.action === "fuse-waste");
    assert.ok(row, "应写一行 fuse-waste");
    assert.equal(row.wasted, 6);
    assert.equal(row.turn, 5);
    assert.equal(row.step, 1, "行里的 step 记熔断点，不记回合末");
    assert.equal(recordFuseWaste("tm-h4"), null, "同一回合不得重复结算");
  });

  test("h5. 换回合作废上一回合熔断点（熔断语义是「本回合内」）", () => {
    resetTraceMeta();
    installTraceMeta();
    resetAudit();
    noteTracePosition("tm-h5", 1, 5);
    appendAudit({ ts: new Date().toISOString(), session: "tm-h5", action: "stall-fuse", level: 3 });
    noteTracePosition("tm-h5", 2, 1);
    assert.equal(recordFuseWaste("tm-h5"), null, "上一回合的熔断点不应结到新回合");
    assert.equal(auditLines().some((r) => r.action === "fuse-waste"), false, "未结算就不写行");
  });

  test("h6. 两会话各自计数、互不相加；无熔断会话不写行", () => {
    resetTraceMeta();
    installTraceMeta();
    resetAudit();
    // 会话 A：熔断 step 2 → 末 step 10（浪费 8）
    noteTracePosition("tm-h6-a", 1, 2);
    appendAudit({ ts: new Date().toISOString(), session: "tm-h6-a", action: "stall-fuse", level: 3 });
    noteTracePosition("tm-h6-a", 1, 10);
    assert.equal(recordFuseWaste("tm-h6-a").wastedSteps, 8);
    // 会话 B：熔断 step 1 → 末 step 4（浪费 3），step 从 1 重新开始，与 A 无关
    noteTracePosition("tm-h6-b", 1, 1);
    appendAudit({ ts: new Date().toISOString(), session: "tm-h6-b", action: "stall-fuse", level: 3 });
    noteTracePosition("tm-h6-b", 1, 4);
    assert.equal(recordFuseWaste("tm-h6-b").wastedSteps, 3);
    // 会话 C：只有正常步，没有熔断
    noteTracePosition("tm-h6-c", 1, 1);
    noteTracePosition("tm-h6-c", 1, 9);
    assert.equal(recordFuseWaste("tm-h6-c"), null);

    const rows = auditLines().filter((r) => r.action === "fuse-waste");
    const bySid = Object.fromEntries(rows.map((r) => [r.session, r.wasted]));
    console.log("[h6] bySession =", JSON.stringify(bySid));
    assert.deepEqual(bySid, { "tm-h6-a": 8, "tm-h6-b": 3 }, "每会话一条、数值互不串");
  });
});
