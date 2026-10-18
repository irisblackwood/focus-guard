import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 授权 ttl 回收（2026-10-18 补口）
// 病根：grants.mjs 自己写着"ttl 只记录、不生效；计时与自动回收见第五步"，第五步一直没做，
// 于是 fg_apply 申请一次 = 进程内永久放行，`ttl: turn` 是空话。
// 本组锁定四件事：turn 档按事件回收、task/persist 不被 turn 误清、硬上限到期即失效、审计留痕。
//
// ⚠ 审计必须重定向：sweepGrants / turnStoppingListener 都会写 AUDIT.log，
//   不设 FG_AUDIT_FILE 就会污染真实工作区（隔离守卫会抓，实测 Δ2 行）。
process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-ttl-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { createGrantTable, TTL_MAX_MS } = await import("../src/core/grants.mjs");

test("sweep('turn')：只回收 turn 档，task/persist 保留", () => {
  const t = createGrantTable();
  t.grant("Bash", { ttl: "turn" });
  t.grant("Write", { ttl: "task" });
  t.grant("Edit", { ttl: "persist" });
  const removed = t.sweep("turn");
  assert.deepEqual(removed, ["Bash"]);
  assert.equal(t.has("Bash"), false);
  assert.equal(t.has("Write"), true);
  assert.equal(t.has("Edit"), true);
});

test("sweep('task')：回收 turn 与 task，保留 persist", () => {
  const t = createGrantTable();
  t.grant("Bash", { ttl: "turn" });
  t.grant("Write", { ttl: "task" });
  t.grant("Edit", { ttl: "persist" });
  const removed = t.sweep("task").sort();
  assert.deepEqual(removed, ["Bash", "Write"]);
  assert.equal(t.has("Edit"), true);
});

test("硬上限：到达 expiresAt 后 has() 立即失效", () => {
  const t = createGrantTable();
  // 用"很久以前"签发：expiresAt 早已过去 → 立即可判失效，不依赖给 Date.now 打桩
  t.grant("Bash", { ttl: "turn", now: 0 });
  assert.equal(t.has("Bash"), false, "超过硬上限应失效");
  assert.equal(t.get("Bash"), undefined);
});

test("list()/size 只计未过期条目", () => {
  const t = createGrantTable();
  t.grant("Bash", { ttl: "turn", now: 1 });
  assert.equal(t.size, 0, "早已过期的条目不应计入 stale size");
  assert.deepEqual(t.list(), []);
});

test("接线：turn-stopping 真的把 turn 档授权回收掉（端到端）", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const gate = await import("../src/adapters/dsh/eligibility-gate.mjs");
  const { turnStoppingListener } = await import("../src/dsh/seams.mjs");
  const { statePath } = await import("../src/core/state.mjs");

  const dir = mkdtempSync(join(tmpdir(), "fg-ttl-e2e-"));
  mkdirSync(join(dir, ".ai"), { recursive: true });
  writeFileSync(join(dir, ".ai", "env-fingerprint.json"), JSON.stringify({ map: {} }));
  const sid = `ttl-e2e-${process.pid}`;
  const agent = { session: { header: { id: sid, cwd: dir } } };

  gate.resetGrants(sid);
  const grant = gate.grantsFor(sid).grant("Bash", { ttl: "turn", reason: "测试" });
  assert.equal(grant.ttl, "turn");
  assert.equal(gate.gateToolCall({ session: sid, tool: "Bash", command: "npm publish" }).kind, "pass", "授权期内应放行");

  await turnStoppingListener({ warn: () => {} })({ agent });

  const after = gate.gateToolCall({ session: sid, tool: "Bash", command: "npm publish" });
  assert.equal(after.kind, "deny", "回合结束后 turn 档授权必须失效");
  rmSync(dir, { recursive: true, force: true });
  rmSync(statePath(sid), { force: true });
  gate.resetGrants(sid);
});
