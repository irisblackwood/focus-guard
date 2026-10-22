import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 人工审批必须"看得见"（2026-10-22 人类反馈）
// 病根：不可逆类别（rm-rf）此前只写 .focus-guard/approvals 并发 CLI 命令，而人类在 GUI 里对话，
// 根本收不到也点不了 → 等于永远拿不到批准。现改为返回 `{kind:'ask'}`，由宿主弹 GUI 审批卡片；
// CLI 通道保留为 headless 兜底。
// 本组锁：① rm-rf 返回 ask（而非 deny）；② 理由里带可读命令与请求号；③ FG_APPROVAL_SEAM=cli 可退回 deny。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-ask-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";
process.env.FG_APPROVAL_DIR = join(tmpdir(), `fg-ask-approvals-${process.pid}`);

const { gateToolCall } = await import("../src/adapters/dsh/eligibility-gate.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-ask-"));
const sid = `ask-${process.pid}`;

function gate(command) {
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  return gateToolCall({ session: sid, tool: "pwsh", command, filePath: null });
}

test("不可逆 rm -rf → 返回 ask（GUI 审批卡片），不是静默 deny", () => {
  const r = gate("rm -rf ./src");
  assert.equal(r.kind, "ask", "必须走 ask 缝，人类才能在 GUI 里点批准");
  assert.match(String(r.reason), /需要人类批准|focusguard approve/);
  assert.match(String(r.reason), /请求号|rm -rf/);
  assert.ok(r.displayReason && r.displayReason.length > 0, "应给 GUI 卡片一句可读标题");
});

test("FG_APPROVAL_SEAM=cli → 退回旧行为（deny + CLI 提示）", () => {
  process.env.FG_APPROVAL_SEAM = "cli";
  const r = gate("rm -rf ./src");
  process.env.FG_APPROVAL_SEAM = "";
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /approve/);
});

test("可逆类别不受影响：./build 直接放行，不弹人工审批", () => {
  // rm-rf 只对根/系统路径判为不可逆（DISPOSABLE_TARGET_RE 分级），./build 属可逆 → 放行。
  const r = gate("rm -rf ./build");
  assert.notEqual(r.kind, "ask", "可逆类别不应触发人工审批卡片");
  assert.notEqual(r.kind, "deny", "可逆类别不应被拦");
});

test.after(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(process.env.FG_APPROVAL_DIR, { recursive: true, force: true });
});
