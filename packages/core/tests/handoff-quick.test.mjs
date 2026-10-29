import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 跨会话快速交接（主图 L4，2026-10-22）
// 目标：新会话打开就能看到"上次会话到哪了"，且**只在新会话**出现（同会话重复注入是噪音）。
// 纪律：快照只存 FG 数得出来的量（工具调用/被拦/KPI/委托），不推断"做到哪了"。

const WORK = mkdtempSync(join(tmpdir(), "fg-handoff-"));
process.env.FG_WORKSPACE_FILE = join(WORK, "workspace.json");
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_SHELL = "";

const ws = await import("../src/dsh/workspace.mjs");

test("写入快照后：卷宗含 snapshot，且可从 JSON 读回", () => {
  const rec = ws.mergeWorkspace(WORK, {
    decisions: ["把审批改成 GUI 卡片"],
    constraints: ["npm publish"],
    snapshot: { at: "2026-10-22T22:00:00.000Z", sid: "session-aaa", toolCalls: 12, denies: 3, kpi: -5, delegateBudget: 19 },
  });
  assert.ok(rec.snapshot, "应保存快照");
  const back = ws.readWorkspace(WORK);
  assert.equal(back.snapshot.toolCalls, 12);
  assert.equal(back.snapshot.delegateBudget, 19);
});

test("新会话（sid 不同）→ 应注入交接快照", () => {
  const rec = ws.readWorkspace(WORK);
  assert.equal(ws.shouldInjectHandoff(rec, "session-bbb"), true);
});

test("同会话（sid 相同）→ 不注入快照（避免重复噪音）", () => {
  const rec = ws.readWorkspace(WORK);
  assert.equal(ws.shouldInjectHandoff(rec, "session-aaa"), false);
  const section = ws.renderWorkspaceSection(rec, { sid: "session-aaa" });
  assert.doesNotMatch(String(section), /上次会话：/);
});

test("同会话内决策增长不再改变注入字节（前缀稳定，2026-10-29）", () => {
  // 实测（tools/prefix-drift.mjs）：系统段每会话 2 个版本，分歧点恒定落在「决策：」这一行。
  // 决策是**历史**，历史每回合都在长；而人类指令原文本来就在会话消息里，抄进系统提示既重复又抖。
  ws.mergeWorkspace(WORK, {
    decisions: ["稳定前缀之前的决策"],
    snapshot: { at: "2026-10-22T22:00:00.000Z", sid: "session-stable", toolCalls: 12, denies: 3, kpi: -5, delegateBudget: 19 },
  });
  const before = String(ws.renderWorkspaceSection(ws.readWorkspace(WORK), { sid: "session-stable" }));
  assert.ok(before.length > 10, "夹具必须真的渲染出内容，否则「相等」等于什么都没验");
  ws.mergeWorkspace(WORK, { decisions: ["同会话里又记了一条"] });
  const after = String(ws.renderWorkspaceSection(ws.readWorkspace(WORK), { sid: "session-stable" }));
  assert.equal(after, before, "同会话内决策增长不得改变注入字节");
  // 换会话才给决策——那是交接信息，不是每回合的噪音
  const fresh = String(ws.renderWorkspaceSection(ws.readWorkspace(WORK), { sid: "session-other" }));
  assert.match(fresh, /决策：/, "新会话应看到上次会话的决策");
});

test("新会话渲染：含「上次会话」行与三类事实", () => {
  const rec = ws.readWorkspace(WORK);
  const section = String(ws.renderWorkspaceSection(rec, { sid: "session-bbb" }));
  assert.match(section, /上次会话：/);
  assert.match(section, /工具调用 12/);
  assert.match(section, /被拦 3/);
  assert.match(section, /决策：/);
});

test("会话首步冻结：并发会话改写快照，本会话的注入字节不变（2026-10-29）", () => {
  // 病根：workspace.json 每工作区一份，并发会话互相覆盖快照，于是 A 的系统提示里
  // 忽而是 B 的快照、忽而是自己的——实测两个真实会话的卷宗段都是 2 个版本，
  // 分歧点就在「上次会话」这一行。冻结后本会话首步渲染什么，整场就是什么。
  ws.resetWorkspaceSectionCache();
  ws.mergeWorkspace(WORK, {
    decisions: ["冻结用例的决策"],
    constraints: ["npm publish"],
    snapshot: { at: "2026-10-29T09:00:00.000Z", sid: "sess-prev", toolCalls: 40, denies: 2, kpi: -9, delegateBudget: 12 },
  });
  const first = String(ws.renderWorkspaceSectionOnce(ws.readWorkspace(WORK), { sid: "sess-freeze" }));
  assert.ok(first.length > 10, "夹具要真的渲染出内容");
  // 另一个会话在同一工作区写了快照（真实场景：并发会话回合结束落盘）
  ws.mergeWorkspace(WORK, {
    snapshot: { at: "2026-10-29T09:30:00.000Z", sid: "sess-other", toolCalls: 7, denies: 1, kpi: -3, delegateBudget: 9 },
  });
  const again = String(ws.renderWorkspaceSectionOnce(ws.readWorkspace(WORK), { sid: "sess-freeze" }));
  assert.equal(again, first, "同会话内必须逐字节不变，否则前缀缓存全废");
  // 不冻结的旧口径会变——这条同时证明夹具是有效的
  assert.notEqual(
    String(ws.renderWorkspaceSection(ws.readWorkspace(WORK), { sid: "sess-freeze" })),
    first,
    "不冻结就会变，说明上面的相等不是因为夹具没差别",
  );
  // 换会话是另一份（交接信息仍然在）
  const other = String(ws.renderWorkspaceSectionOnce(ws.readWorkspace(WORK), { sid: "sess-new" }));
  assert.match(other, /上次会话：sess-other/, "新会话应看到最新的上一场快照");
  // 进程重启（清缓存）等价于重新取一次
  ws.resetWorkspaceSectionCache();
  assert.match(String(ws.renderWorkspaceSectionOnce(ws.readWorkspace(WORK), { sid: "sess-freeze" })), /sess-other/);
});

test("冻结只冻非空：新工作区首步没内容时，后面有内容仍能注入", () => {
  ws.resetWorkspaceSectionCache();
  const empty = ws.renderWorkspaceSectionOnce(null, { sid: "sess-late" });
  assert.equal(empty, null, "没有卷宗就不注入");
  ws.mergeWorkspace(WORK, { decisions: ["后来的决策"] });
  const rec = ws.readWorkspace(WORK);
  const later = ws.renderWorkspaceSectionOnce(rec, { sid: "sess-late" });
  assert.ok(later, "空渲染不该被冻结，否则整场都拿不到卷宗");
});

test("快照是覆盖式：第二次写入不累积旧快照", () => {
  ws.mergeWorkspace(WORK, { snapshot: { at: "2026-10-22T23:00:00.000Z", sid: "session-ccc", toolCalls: 1, denies: 0, kpi: 0, delegateBudget: 20 } });
  const rec = ws.readWorkspace(WORK);
  assert.equal(rec.snapshot.sid, "session-ccc");
  assert.equal(rec.snapshot.toolCalls, 1);
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
