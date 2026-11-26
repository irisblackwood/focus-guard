import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 卷宗质量筛选（2026-10-22 人类批示"A 并做质量筛选"）
// 病根：clean() 满 10 条就 break → 保留的是**最早**的 10 条，于是卷宗塞满会话开头的废话
// （终端报错、骂人话、8 任务表格），最近的决策进不来。现改为保留最新，
// 并加 pickDecisionText() 过滤：表格/代码块/报错/子代理回执/超长转述都不算"人类指令"。

process.env.FG_WORKSPACE_FILE = join(mkdtempSync(join(tmpdir(), "fg-ws-")), "workspace.json");
process.env.FG_SHELL = "";

const ws = await import("../src/dsh/workspace.mjs");

test("只保留最新：写入 15 条，读回的是最后 10 条", () => {
  ws.mergeWorkspace("E:/DSH/focus-guard-main", {
    decisions: Array.from({ length: 15 }, (_, i) => `决策 ${i + 1}`),
  });
  const rec = ws.readWorkspace("E:/DSH/focus-guard-main");
  assert.equal(rec.decisions.length, 10);
  assert.equal(rec.decisions[0], "决策 6", "应丢掉最早的 5 条");
  assert.equal(rec.decisions.at(-1), "决策 15");
});

test("质量筛选：表格 / 代码块 / 报错 / 子代理回执 / 超长 一律不记", () => {
  const rejects = [
    "| # | 动作 | 结果 |\n|---|---|---|",
    "```js\nconst x = 1\n```",
    "npm error code E403",
    "Error: something broke",
    "Background subagent 2298eb4c finished",
    "x".repeat(200),
    "a",
  ];
  for (const r of rejects) assert.equal(ws.pickDecisionText(r), "", `应剔除：${r.slice(0, 30)}`);
});

test("质量筛选：正常指令保留第一行并压平空白", () => {
  assert.equal(ws.pickDecisionText("把审批改成 GUI 卡片\n\n顺便跑一遍 check"), "把审批改成 GUI 卡片");
  assert.equal(ws.pickDecisionText("  做A 并 做B  "), "做A 并 做B");
});

// 下架验收（2026-11-26）：这条守的是「不写」，与 handoff-quick 的「不注入」互补。
// 缺了它，下次有人把 pickDecisionText 接回落账路径，测试全绿而缺陷复发。
test("下架：recordWorkspaceTurn 不再写 decisions，原文不落盘", () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-turn-"));
  const stateDir = join(TMP, "state");
  const proj = join(TMP, "proj");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const saved = { state: process.env.FG_STATE_DIR, ws: process.env.FG_WORKSPACE_FILE };
  process.env.FG_STATE_DIR = stateDir;
  process.env.FG_WORKSPACE_FILE = join(TMP, "workspace.json");
  try {
    const sid = "sess-dec-off";
    writeFileSync(
      join(stateDir, `focus-guard-${sid}.json`),
      JSON.stringify({ turnPrompt: "请把审批改成 GUI 卡片", rejectedCmds: { "npm publish": 1 }, turnCalls: 3, denyCount: 1 }),
    );
    const rec = ws.recordWorkspaceTurn({ session: { header: { cwd: proj, id: sid } } });
    assert.ok(rec, "应返回写入后的记录");
    assert.deepEqual(rec.decisions, [], "决策已下架：不得再写入人类指令原文");
    assert.ok(!JSON.stringify(rec).includes("把审批改成 GUI 卡片"), "指令原文不得落盘");
    assert.deepEqual(rec.constraints, ["npm publish"], "约束仍要写——下架的是决策，不是整块落账");
    assert.equal(rec.snapshot.denies, 1, "快照仍要写");
  } finally {
    if (saved.state === undefined) delete process.env.FG_STATE_DIR;
    else process.env.FG_STATE_DIR = saved.state;
    if (saved.ws === undefined) delete process.env.FG_WORKSPACE_FILE;
    else process.env.FG_WORKSPACE_FILE = saved.ws;
    rmSync(TMP, { recursive: true, force: true });
  }
});
