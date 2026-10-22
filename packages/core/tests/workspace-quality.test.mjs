import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
