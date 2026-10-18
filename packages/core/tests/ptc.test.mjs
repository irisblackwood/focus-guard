import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

// FGA-PTC 两块补口（2026-10-18，主图 L3）
//   FGA1 默认只读：写类工具 / 变更型 shell 未授权即拦（此前只有"高危清单"这一层，
//        普通 Write/Edit、rm -rf ./dist 这类不算高危的写操作默认是放行的）
//   FGA3 静默秒批：**可逆**类别（publish / global-install / chmod）自动批准，
//        不可逆类别（rm-rf / drop-database / git-push-force / write-system-path）仍走人工
// 两个开关都默认关，测试里显式打开，避免主线语义被悄悄改掉。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-ptc-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const gate = await import("../src/adapters/dsh/eligibility-gate.mjs");

const SID = `ptc-${process.pid}`;

test("默认关闭：普通写工具照常放行（不改主线语义）", () => {
  delete process.env.FG_PTC_READONLY;
  gate.resetGrants(SID);
  const r = gate.gateToolCall({ session: SID, tool: "Write", filePath: "E:/tmp/x.txt" });
  assert.equal(r.kind, "pass");
});

test("默认只读开启：写类工具未授权即拦，理由指向 fg_apply", () => {
  process.env.FG_PTC_READONLY = "1";
  gate.resetGrants(SID);
  const r = gate.gateToolCall({ session: SID, tool: "Write", filePath: "E:/tmp/x.txt" });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /fg_apply/);
  assert.match(String(r.reason), /ptc:write/);
});

test("默认只读开启：变更型 shell 拦，只读 shell 放行", () => {
  process.env.FG_PTC_READONLY = "1";
  gate.resetGrants(SID);
  const mutate = gate.gateToolCall({ session: SID, tool: "Bash", command: "rm -rf ./dist" });
  assert.equal(mutate.kind, "deny", "变更型 shell 应拦");
  assert.match(String(mutate.reason), /ptc:shell/);
  const read = gate.gateToolCall({ session: SID, tool: "Bash", command: "ls -la" });
  assert.equal(read.kind, "pass", "只读 shell 不受默认只读影响");
  delete process.env.FG_PTC_READONLY;
});

test("默认只读：授权后同一工具放行（按需申请闭环）", async () => {
  process.env.FG_PTC_READONLY = "1";
  gate.resetGrants(SID);
  gate.clearPending(SID);
  assert.equal(gate.gateToolCall({ session: SID, tool: "Bash", command: "rm -rf ./dist" }).kind, "deny");
  const applied = await gate.applyEligibility({
    session: SID,
    tool: "Bash",
    command: "rm -rf ./dist",
    purpose: "清理构建产物",
    scope: "仅 ./dist",
    ttl: "turn",
    redlines: [],
  });
  assert.equal(applied.decision, "allow");
  assert.equal(gate.gateToolCall({ session: SID, tool: "Bash", command: "rm -rf ./dist" }).kind, "pass");
  gate.resetGrants(SID);
  delete process.env.FG_PTC_READONLY;
});

test("静默秒批：可逆类别（publish）自动批准并留痕", async () => {
  process.env.FG_PTC_AUTO_GRANT = "1";
  const sid = `ptc-auto-${process.pid}`;
  gate.resetGrants(sid);
  const r = await gate.applyEligibility({
    session: sid,
    tool: "Bash",
    command: "npm publish --access public",
    purpose: "发布包",
    scope: "npm registry",
    ttl: "turn",
    redlines: [],
  });
  // 注意：可逆类别事实上**本来就通过**——applyOneEligibility 在审核期先给临时授权，
  // 母版 L3 因此放行（这就是"秒批"的真实机制，不是 needApproval 之后再特批）。
  assert.equal(r.decision, "allow");
  gate.resetGrants(sid);
  delete process.env.FG_PTC_AUTO_GRANT;
});

test("严格档：不可逆类别（rm-rf）不再自证自批", async () => {
  process.env.FG_PTC_STRICT_IRREVERSIBLE = "1";
  const sid = `ptc-strict-${process.pid}`;
  gate.resetGrants(sid);
  const r = await gate.applyEligibility({
    session: sid,
    tool: "Bash",
    command: "rm -rf ./app-src",
    purpose: "删除源码目录",
    scope: "仅本目录",
    ttl: "turn",
    redlines: [],
  });
  assert.equal(r.decision, "needApproval", "不可逆类别必须交人类");
  assert.match(String(r.reason), /需人类明确批示/);
  assert.equal(gate.gateToolCall({ session: sid, tool: "Bash", command: "rm -rf ./app-src" }).kind, "deny", "未授权前仍应拦");
  gate.resetGrants(sid);
  delete process.env.FG_PTC_STRICT_IRREVERSIBLE;
});

test("静默秒批：不可逆类别（write-system-path）不被秒批", async () => {
  process.env.FG_PTC_AUTO_GRANT = "1";
  const sid = `ptc-noauto-${process.pid}`;
  gate.resetGrants(sid);
  const r = await gate.applyEligibility({
    session: sid,
    tool: "Write",
    command: "write C:\\Windows\\System32\\drivers\\etc\\hosts",
    purpose: "改系统配置",
    scope: "系统目录",
    ttl: "turn",
    redlines: [],
  });
  assert.notEqual(r.decision, "allow", "不可逆类别必须仍走人工");
  gate.resetGrants(sid);
  delete process.env.FG_PTC_AUTO_GRANT;
});

test.after(() => {
  delete process.env.FG_PTC_READONLY;
  delete process.env.FG_PTC_AUTO_GRANT;
  gate.resetGrants(SID);
});
