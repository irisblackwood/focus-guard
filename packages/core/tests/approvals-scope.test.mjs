import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 批准的作用域（2026-10-29）：此前批准只有"一次性 + 命令哈希"两道锁，
// 消费端**不看会话、不看时间**——A 会话批的 `rm -rf /data` 没重试，几小时后 B 会话
// 跑同一条命令照样消费。本文件锁死新加的两道：④ 绑会话 ⑤ 有时效。
//
// 纯模块级用例（不走闸），外加一条闸级用例证明拦截路径真的传了 session。

const DIR = join(tmpdir(), `fg-approve-scope-${process.pid}-${Date.now()}`);
process.env.FG_APPROVAL_DIR = DIR;
process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-approve-scope-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_APPROVAL_SEAM = "cli";

const approvals = await import("../src/core/approvals.mjs");
const gate = await import("../src/adapters/dsh/eligibility-gate.mjs");

const CMD = "rm -rf ./scope-target";

/** 走一遍「申请 → 批准」，返回 id。 */
function requestAndApprove(session, command = CMD) {
  const req = approvals.createApprovalRequest({ session, tool: "Bash", command, gateId: "rm-rf" });
  const ok = approvals.approveRequest(req.id);
  assert.equal(ok.ok, true, "批准应成功（pending 必须是这条）");
  return req.id;
}

test("同会话消费：生效", () => {
  const id = requestAndApprove("sess-A");
  const r = approvals.consumeApproval("Bash", CMD, "sess-A");
  assert.equal(r.consumed, true);
  assert.equal(r.id, id);
  assert.equal(r.loose, false, "两侧身份都认得出，不该走宽松通道");
  assert.equal(existsSync(join(DIR, `approved-${id}.json`)), false, "消费即删");
});

test("跨会话消费：不生效，且批准文件保留给原会话", () => {
  const id = requestAndApprove("sess-A");
  const r = approvals.consumeApproval("Bash", CMD, "sess-B");
  assert.equal(r.consumed, false, "别的会话不能消费");
  assert.equal(r.wrongSession, true);
  assert.ok(existsSync(join(DIR, `approved-${id}.json`)), "拒绝不能顺手删掉原会话的批准");
  // 原会话随后仍可用——拒绝不是作废
  const again = approvals.consumeApproval("Bash", CMD, "sess-A");
  assert.equal(again.consumed, true);
});

test("身份不可判定（dsh-native / unknown / 缺省）不误杀，但标记 loose", () => {
  const cases = [
    ["dsh-native", "real-session-1"],
    ["real-session-2", "unknown"],
    ["dsh-native", "dsh-native"],
  ];
  for (const [writer, consumer] of cases) {
    requestAndApprove(writer);
    const r = approvals.consumeApproval("Bash", CMD, consumer);
    assert.equal(r.consumed, true, `${writer} → ${consumer} 应放行（身份不可判定）`);
    assert.equal(r.loose, true, `${writer} → ${consumer} 应标记 loose`);
  }
  // 兼容旧的两参调用（HANDOFF 里写的签名就是两参）
  requestAndApprove("real-session-3");
  const legacy = approvals.consumeApproval("Bash", CMD);
  assert.equal(legacy.consumed, true);
  assert.equal(legacy.loose, true, "不传会话等于身份不可判定");
});

test("过期不生效：批准文件当场清掉", () => {
  const id = requestAndApprove("sess-T");
  const file = join(DIR, `approved-${id}.json`);
  // 把 approvedAt 拨回 31 分钟前（默认 TTL 30 分钟）
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.approvedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  const r = approvals.consumeApproval("Bash", CMD, "sess-T");
  assert.equal(r.consumed, false, "过期批准不得放行");
  assert.equal(r.expired, true);
  assert.ok(r.ageMs >= 30 * 60 * 1000, "应报出真实年龄");
  assert.equal(existsSync(file), false, "过期批准应清掉，不能留在目录里");
});

test("时效窗口可调（FG_APPROVAL_TTL_MS）", () => {
  const id = requestAndApprove("sess-W");
  const file = join(DIR, `approved-${id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.approvedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 分钟前
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  assert.equal(approvals.consumeApproval("Bash", CMD, "sess-W").consumed, true, "5 分钟 < 默认 30 分钟，应有效");

  requestAndApprove("sess-W2");
  const file2 = join(DIR, `approved-${approvals.approvalId("Bash", CMD)}.json`);
  const rec2 = JSON.parse(readFileSync(file2, "utf8"));
  rec2.approvedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeFileSync(file2, JSON.stringify(rec2, null, 2) + "\n");
  process.env.FG_APPROVAL_TTL_MS = String(60 * 1000); // 收到 1 分钟
  const tight = approvals.consumeApproval("Bash", CMD, "sess-W2");
  assert.equal(tight.expired, true, "阈值调到 1 分钟后，5 分钟前的批准应过期");
  delete process.env.FG_APPROVAL_TTL_MS;
});

test("approvedAt 不可解析 → 判过期（fail closed）", () => {
  const id = requestAndApprove("sess-N");
  const file = join(DIR, `approved-${id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  delete rec.approvedAt;
  delete rec.ts;
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  const r = approvals.consumeApproval("Bash", CMD, "sess-N");
  assert.equal(r.consumed, false, "没有时间戳就不知道是否过期，宁可拒绝");
  assert.equal(r.expired, true);
});

test("闸级：跨会话的批准在 gateToolCall 里依然被拦，并留 session-mismatch 审计", () => {
  const A = "gate-sess-A";
  const B = "gate-sess-B";
  const cmd = "rm -rf ./gate-scope-target";
  requestAndApprove(A, cmd);
  gate.resetGrants(B);
  const r = gate.gateToolCall({ session: B, tool: "Bash", command: cmd });
  assert.equal(r.kind, "deny", "B 会话不得凭 A 的批准通过");
  const log = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  assert.match(log, /approval-session-mismatch/, "应留下会话不匹配的审计");
  assert.match(log, new RegExp(approvals.approvalId("Bash", cmd)), "证据里应带批准 id");
  // A 自己仍然能过
  gate.resetGrants(A);
  const ok = gate.gateToolCall({ session: A, tool: "Bash", command: cmd });
  assert.equal(ok.kind, "pass", "原会话仍可消费自己的批准");
});
