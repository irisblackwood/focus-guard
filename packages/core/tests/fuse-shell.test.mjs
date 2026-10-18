import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 熔断口径统一（2026-10-18）
// 病根：layer3Check 的早退条件只看「写类工具 或 shell 写目标」，而 `git commit` / `npm install`
// 这类命令没有重定向 → shellTargets 为空 → 整条第 3 层（含熔断/降权）被跳过。
// 实测：会话被判熔断后 write 被拒，`Bash git commit` 却提交成功。
// 本组锁定：熔断期变更型 shell 与写类工具同等对待；只读 shell 不受影响。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-fuse-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-fuse-"));
mkdirSync(join(DIR, ".ai"), { recursive: true });
writeFileSync(join(DIR, ".ai", "env-fingerprint.json"), JSON.stringify({ map: {} }));
writeFileSync(join(DIR, "a.txt"), "x\n");

const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });

function run(sid, tool, args, overrides = {}) {
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, ...overrides });
  return listener(
    {
      sessionId: sid,
      name: tool,
      arguments: args,
      agent: { session: { header: { id: sid, cwd: DIR } } },
    },
    allow,
  );
}

test("熔断期：git commit（无重定向的变更型 shell）必须被拒", async () => {
  const sid = `fuse-commit-${process.pid}`;
  const r = await run(sid, "Bash", { command: "git commit -m test" }, { fused: true });
  assert.equal(r.kind, "deny", "熔断期不得放行变更型 shell");
  assert.match(String(r.reason), /熔断/);
});

test("熔断期：npm install 同样被拒", async () => {
  const sid = `fuse-install-${process.pid}`;
  const r = await run(sid, "Bash", { command: "npm install" }, { fused: true });
  assert.equal(r.kind, "deny");
});

test("熔断期：只读命令仍放行", async () => {
  const sid = `fuse-read-${process.pid}`;
  const r = await run(sid, "Bash", { command: "git status --short" }, { fused: true });
  assert.notEqual(r.kind, "deny", "熔断是只读模式，不是全禁");
});

test("未熔断：变更型 shell 正常放行（不误伤日常提交）", async () => {
  const sid = `fuse-normal-${process.pid}`;
  const r = await run(sid, "Bash", { command: "git commit -m test" });
  assert.notEqual(r.kind, "deny");
});

test("降权（probation）同样拦变更型 shell", async () => {
  const sid = `fuse-probation-${process.pid}`;
  const r = await run(sid, "Bash", { command: "npm install" }, { probation: true });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /降权/);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
