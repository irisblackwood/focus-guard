import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实参数回归（2026-10-19）：8 任务实测发现三条闸在真实 DSH 参数下全部摸不到。
//   实测证据 session-002c143b（FG 开）：
//     ① read {file_path:"packages/core/src/dsh/pipeline.mjs"}（相对路径）→ 整读 1022 行未被拦
//     ② pwsh {command:"Add-Content -Path packages/core/README.md ..."}（相对路径）→ 盲写未被拦
//     ③ grep {pattern:"state", path:"packages/core/src"}（真实 schema 无 output_mode/head_limit）→ 体积闸未触发
// 根因一：路径按宿主 cwd 解析，不是会话 cwd → statSync/existsSync 假阴性。
// 根因二：Grep 闸条件建立在合成参数上。
// 本组用**真实参数形状**锁回归，不用合成参数。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-real-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-real-"));
mkdirSync(join(DIR, ".ai"), { recursive: true });
mkdirSync(join(DIR, "src"), { recursive: true });
writeFileSync(join(DIR, ".ai", "env-fingerprint.json"), JSON.stringify({ map: {} }));
writeFileSync(join(DIR, "README.md"), "# readme\n");
writeFileSync(join(DIR, "src", "big.mjs"), Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`).join("\n"));

const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });

function run(sid, tool, args, seed = false) {
  if (seed) saveState(statePath(sid), { fused: false, probation: false, readSet: {} });
  return listener(
    { sessionId: sid, name: tool, arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    allow,
  );
}

test("相对路径整读大文件（真实形状）→ 必须拦", async () => {
  const sid = `real-read-rel-${process.pid}`;
  const r = await run(sid, "read", { file_path: "src/big.mjs" });
  assert.equal(r.kind, "deny", "相对路径必须按会话 cwd 解析后判行数");
  assert.match(String(r.reason), /整文件闸/);
  rmSync(statePath(sid), { force: true });
});

test("绝对路径整读大文件 → 仍拦（不回归）", async () => {
  const sid = `real-read-abs-${process.pid}`;
  const r = await run(sid, "read", { file_path: join(DIR, "src", "big.mjs") });
  assert.equal(r.kind, "deny");
  rmSync(statePath(sid), { force: true });
});

test("分段读（offset/limit）→ 放行", async () => {
  const sid = `real-read-seg-${process.pid}`;
  const r = await run(sid, "read", { file_path: "src/big.mjs", offset: 1, limit: 30 });
  assert.notEqual(r.kind, "deny");
  rmSync(statePath(sid), { force: true });
});

test("相对路径 Add-Content 盲改已存在文件 → 必须拦", async () => {
  const sid = `real-shell-rel-${process.pid}`;
  const r = await run(sid, "pwsh", { command: 'Add-Content -Path README.md -Value "x"' }, true);
  assert.equal(r.kind, "deny", "shell 写目标必须按会话 cwd 解析后查取证");
  assert.match(String(r.reason), /取证|未读/);
  rmSync(statePath(sid), { force: true });
});

test("Grep 目录级搜索未给 include（真实 schema）→ 必须拦", async () => {
  const sid = `real-grep-dir-${process.pid}`;
  const r = await run(sid, "grep", { pattern: "state", path: "src" });
  assert.equal(r.kind, "deny", "目录级 content 搜索应收窄");
  assert.match(String(r.reason), /Grep 未收窄|include/);
  rmSync(statePath(sid), { force: true });
});

test("Grep 给了 include → 放行", async () => {
  const sid = `real-grep-inc-${process.pid}`;
  const r = await run(sid, "grep", { pattern: "state", path: "src", include: "**/*.mjs" });
  assert.notEqual(r.kind, "deny");
  rmSync(statePath(sid), { force: true });
});

test("Grep 单文件路径 → 放行", async () => {
  const sid = `real-grep-file-${process.pid}`;
  const r = await run(sid, "grep", { pattern: "state", path: "src/big.mjs" });
  assert.notEqual(r.kind, "deny");
  rmSync(statePath(sid), { force: true });
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
