import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 原生侧批量审批（2026-10-18，主图 L3 FGA「合并出示 / 静默秒批」）
// 母版 approval.mjs 的 highRiskQueue/queueNote 只服务 ZCode；原生侧此前每条高危都要
// "申请 + 重试"两次往返。本组锁定：待批队列合并提示、一次申请批量授权、授权后清队列。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-batch-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const gate = await import("../src/adapters/dsh/eligibility-gate.mjs");

const SID = `batch-${process.pid}`;

test("第一次拦截进待批队列，理由不含合并提示", () => {
  gate.resetGrants(SID);
  gate.clearPending(SID);
  const r = gate.gateToolCall({ session: SID, tool: "Bash", command: "npm publish --access public" });
  assert.equal(r.kind, "deny");
  assert.doesNotMatch(String(r.reason), /另有 \d+ 条待批/);
  assert.equal(gate.pendingOf(SID).length, 1);
});

test("第二次拦截带出合并提示，列出可批量申请的工具名", () => {
  const r = gate.gateToolCall({ session: SID, tool: "Write", command: "C:\\Windows\\System32\\x.txt" });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /另有 1 条待批已合并/);
  assert.match(String(r.reason), /tool="(Write,Bash|Bash,Write)"/);
  assert.equal(gate.pendingOf(SID).length, 2);
});

test("一次 fg_apply 批量申请 → 两个工具同时授权、待批队列清空", async () => {
  const r = await gate.applyEligibility({
    session: SID,
    tool: "Bash,Write",
    command: "批量申请：发布与系统路径写入",
    purpose: "A/B 实测需要一次批准覆盖两条待批",
    scope: "本会话内 Bash 与 Write 的高危调用",
    ttl: "turn",
    redlines: [],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.tools.length, 2);
  assert.equal(gate.pendingOf(SID).length, 0, "批量通过后应清空待批队列");
  assert.equal(gate.gateToolCall({ session: SID, tool: "Bash", command: "npm publish" }).kind, "pass");
  assert.equal(
    gate.gateToolCall({ session: SID, tool: "Write", filePath: "C:\\Windows\\System32\\x.txt" }).kind,
    "pass",
  );
});

test("批量申请整体不通过（L0 申请不完整）→ 不清空待批队列", async () => {
  const sid = `batch-deny-${process.pid}`;
  gate.resetGrants(sid);
  gate.clearPending(sid);
  gate.gateToolCall({ session: sid, tool: "Bash", command: "npm publish" });
  const r = await gate.applyEligibility({
    session: sid,
    tool: "Bash,Write",
    command: "批量申请",
    purpose: "", // 故意留空：母版 L0 要求 purpose/scope 必填
    scope: "",
    ttl: "turn",
    redlines: [],
  });
  assert.notEqual(r.decision, "allow", "申请不完整时批量不应通过");
  assert.ok(gate.pendingOf(sid).length >= 1, "未通过时不得清空待批队列");
  gate.resetGrants(sid);
  gate.clearPending(sid);
});

test.after(() => {
  gate.resetGrants(SID);
  gate.clearPending(SID);
});
