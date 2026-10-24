import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 结果准入预算（2026-10-24，新功能③）
// 体积闸只按硬阈值（默认 200KB）拦；但"每次只差一点"的多次中等体积整读同样撑爆上下文。
// 本组锁：① 额度内放行并递减 ② 用尽即拒 ③ 分段读不受限 ④ 0=关闭该闸。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-admit-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";
process.env.FG_RESULT_ADMIT_BYTES = "2048"; // 2KB，便于测试
process.env.FG_RESULT_ADMIT_BUDGET = "2";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState, loadState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-admit-"));
writeFileSync(join(DIR, "big.txt"), "x".repeat(4096)); // 4KB > 2KB 阈值
writeFileSync(join(DIR, "small.txt"), "x".repeat(100));

const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });
const sid = `admit-${process.pid}`;

function run(args, statePatch = {}) {
  const file = statePath(sid);
  const prev = loadState(file) || {}
  saveState(file, { fused: false, probation: false, readSet: {}, caseCache: {}, ...prev, ...statePatch });
  return listener(
    { sessionId: sid, name: "read", arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    allow,
  );
}

test("额度内：放行且额度递减", async () => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, resultAdmitLeft: 2 });
  const r1 = await run({ file_path: "big.txt" });
  assert.notEqual(r1 && r1.kind, "deny", "首次应放行");
  const r2 = await run({ file_path: "big.txt" });
  assert.notEqual(r2 && r2.kind, "deny", "第二次应放行");
});

test("额度用尽：再读大文件 → 拒，理由指向结果准入", async () => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, resultAdmitLeft: 0 });
  const r = await run({ file_path: "big.txt" });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /结果准入|额度/);
});

test("分段读不受限（带 limit）", async () => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, resultAdmitLeft: 0 });
  const r = await run({ file_path: "big.txt", limit: 20 });
  assert.notEqual(r && r.kind, "deny");
});

test("小文件不受本闸影响", async () => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, resultAdmitLeft: 0 });
  const r = await run({ file_path: "small.txt" });
  assert.notEqual(r && r.kind, "deny");
});

test.after(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(statePath(sid), { force: true });
  rmSync(process.env.FG_AUDIT_FILE, { force: true });
});
