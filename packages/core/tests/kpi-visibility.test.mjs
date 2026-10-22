import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// KPI 可见性（2026-10-22，人类反馈"KPI 感觉不到"）
// 事实：KPI 全仓只有写入与结算，**没有任何读取做判定** —— 所以它天然不可感知。
// 本组锁三件事：① 结算后可写快照；② 快照进 status.json；③ 快照进 livenessBadge（FG 说话时才露出）。
// 纪律：只做展示，绝不影响允许/拒绝。

const WORK = mkdtempSync(join(tmpdir(), "fg-kpi-vis-"));
process.env.FG_STATUS_FILE = join(WORK, "status.json");
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_SHELL = "";

const hb = await import("../src/dsh/heartbeat.mjs");
const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

test("设置快照后：徽标带 KPI 与委托池余量", () => {
  hb.setKpiSnapshot({ kpi: -5, delegateBudget: 19 });
  const badge = hb.livenessBadge();
  assert.match(badge, /KPI -5/);
  assert.match(badge, /委托 19/);
});

test("KPI 为正时带 + 号，便于一眼分辨奖惩", () => {
  hb.setKpiSnapshot({ kpi: 15, delegateBudget: 20 });
  assert.match(hb.livenessBadge(), /KPI \+15/);
});

test("快照写进 status.json（外部可读）", async () => {
  hb.setKpiSnapshot({ kpi: -640, delegateBudget: 3 });
  const stop = hb.startHeartbeat({ warn: () => {} });
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const body = JSON.parse(readFileSync(process.env.FG_STATUS_FILE, "utf8"));
  assert.equal(body.kpi, -640);
  assert.equal(body.delegate_budget, 3);
  assert.ok(body.kpi_at, "应记录快照时间");
});

test("KPI 快照不影响判定（拦/放与 KPI 无关）", async () => {
  const { statePath: sp, saveState: ss } = await import("../src/core/state.mjs");
  const sid = `kpi-vis-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "fg-kpi-gate-"));
  const listener = preExecuteListener({ warn: () => {} });
  const run = async (kpi) => {
    hb.setKpiSnapshot({ kpi, delegateBudget: 20 });
    ss(sp(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
    return listener(
      { sessionId: sid, name: "pwsh", arguments: { command: "rm -rf ./build" }, agent: { session: { header: { id: sid, cwd: dir } } } },
      () => ({ kind: "allow" }),
    );
  };
  const low = await run(-999);
  const high = await run(999);
  assert.equal((low && low.kind) || "allow", (high && high.kind) || "allow", "KPI 不得改变判定");
  rmSync(sp(sid), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
