import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// 2026-10-22：本文件专门测 **CLI 审批通道**（文件 + focusguard approve），
// 而默认已改为宿主 ask 缝（GUI 卡片）；显式退回 cli 让这组继续覆盖那条路径。
process.env.FG_APPROVAL_SEAM = "cli";
import { fileURLToPath } from "node:url";

// 文件审批闸（B 方案，2026-10-18）：拦截 → 生成 pending_request.json →
// 人类终端 `focusguard approve <id>` → 模型下一轮消费批准并放行**一次**。
// 锁定四件事：请求生成与 id 绑定、批准幂等/防批错、消费一次性、CLI 真能写状态。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-seam-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_APPROVAL_DIR = join(tmpdir(), `fg-seam-approvals-${process.pid}-${Date.now()}`);
process.env.FG_SHELL = "";

const gate = await import("../src/adapters/dsh/eligibility-gate.mjs");
const approvals = await import("../src/core/approvals.mjs");

const CMD = "rm -rf ./seam-target";
const SID = `seam-${process.pid}`;

test("拦截即生成审批请求，id 与命令绑定", async () => {
  gate.resetGrants(SID);
  const r = await gate.applyEligibility({
    session: SID,
    tool: "Bash",
    command: CMD,
    purpose: "删除测试目录",
    scope: "仅 ./seam-target",
    ttl: "turn",
    redlines: [],
  });
  assert.equal(r.decision, "needApproval");
  const pending = approvals.readApprovalRequest();
  assert.ok(pending, "应写出 pending_request.json");
  assert.equal(pending.id, approvals.approvalId("Bash", CMD), "id 应由工具+命令哈希决定");
  assert.equal(pending.tool, "Bash");
  assert.match(String(r.reason), new RegExp(pending.id), "理由里应带 id");
});

test("批错 id 不生效", () => {
  const bad = approvals.approveRequest("deadbeef0000");
  assert.equal(bad.ok, false);
});

test("CLI approve <id> 真的写批准状态", () => {
  const pending = approvals.readApprovalRequest();
  const cli = fileURLToPath(new URL("../tools/focusguard.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [cli, "approve", pending.id], { encoding: "utf8" });
  assert.match(out, /已批准/);
  assert.ok(existsSync(join(process.env.FG_APPROVAL_DIR, `approved-${pending.id}.json`)), "应写 approved-<id>.json");
});

test("批准后放行一次；再重置授权即失效（一次性）", () => {
  gate.resetGrants(SID);
  const first = gate.gateToolCall({ session: SID, tool: "Bash", command: CMD });
  assert.equal(first.kind, "pass", "批准后应放行");
  assert.equal(approvals.readApprovalRequest(), null, "消费后 pending 应清空");
  gate.resetGrants(SID); // 模拟 ttl 回收
  const second = gate.gateToolCall({ session: SID, tool: "Bash", command: CMD });
  assert.equal(second.kind, "deny", "批准只能放行一次，消费后应重新拦");
  // 被重新拦截时会再生成一条新的审批请求——这是预期行为（不是残留）
  assert.ok(approvals.readApprovalRequest(), "再次拦截应重新生成待批请求");
});

test("改了命令原文 → 原批准不生效（防偷换）", () => {
  gate.resetGrants(SID);
  approvals.approveRequest(approvals.approvalId("Bash", CMD)); // 尝试补批（此时 pending 已被消费，应失败）
  const other = gate.gateToolCall({ session: SID, tool: "Bash", command: "rm -rf ./other-target" });
  assert.equal(other.kind, "deny", "不同命令必须重新申请");
});

test.after(() => {
  gate.resetGrants(SID);
});
