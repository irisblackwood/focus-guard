import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 取证闸补口（2026-10-18）：shell 重定向与写 cmdlet 与 Edit 等效，必须同样先取证。
// 依据：A/B 会话对照 B 组第 2 条 —— 代理用 `pwsh Add-Content` 盲改 README，旧实现放行。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-evidence-shell-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-shell-evidence-"));
mkdirSync(join(DIR, ".ai"), { recursive: true });
writeFileSync(join(DIR, ".ai", "env-fingerprint.json"), JSON.stringify({ map: {} }));
writeFileSync(join(DIR, "README.md"), "# readme\n");
writeFileSync(join(DIR, "pkg.json"), "{}\n");

const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });

function run(sid, command) {
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  return listener(
    {
      sessionId: sid,
      name: "Bash",
      arguments: { command },
      agent: { session: { header: { id: sid, cwd: DIR } } },
    },
    allow,
  );
}

const target = join(DIR, "README.md");

test("shell 追加已存在文件（未读）→ deny", async () => {
  const r = await run(`shell-append-${process.pid}`, `Add-Content -Path "${target}" -Value "x"`);
  assert.equal(r.kind, "deny", "shell 写已存在文件应要求先取证");
  assert.match(String(r.reason), /取证|未读/);
});

test("POSIX 重定向追加已存在文件（未读）→ deny", async () => {
  const r = await run(`shell-redirect-${process.pid}`, `echo x >> "${target}"`);
  assert.equal(r.kind, "deny");
});

test("sed -i 改已存在文件（未读）→ deny", async () => {
  const r = await run(`shell-sed-${process.pid}`, `sed -i 's/a/b/' "${target}"`);
  assert.equal(r.kind, "deny");
});

test("写新建文件 → 放行（新建无既有内容，取证无意义）", async () => {
  const fresh = join(DIR, "brand-new.txt");
  const r = await run(`shell-new-${process.pid}`, `echo x > "${fresh}"`);
  assert.notEqual(r.kind, "deny", "新建文件不得因取证闸而死锁");
});

test("重定向到 NUL / 句柄复制 → 不算写文件，放行", async () => {
  const r = await run(`shell-nul-${process.pid}`, "echo x 2>&1 > NUL");
  assert.notEqual(r.kind, "deny");
});

test("普通只读 shell（git status）不受影响", async () => {
  const r = await run(`shell-readonly-${process.pid}`, "git status --short");
  assert.notEqual(r.kind, "deny");
});

test("先读再写同一文件 → 放行", async () => {
  const sid = `shell-readthenwrite-${process.pid}`;
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  const exec = (name, args) => ({
    sessionId: sid,
    name,
    arguments: args,
    agent: { session: { header: { id: sid, cwd: DIR } } },
  });
  await listener(exec("Read", { file_path: target }), allow);
  const r = await listener(exec("Bash", { command: `Add-Content -Path "${target}" -Value "y"` }), allow);
  assert.notEqual(r.kind, "deny", "已读过的文件应放行");
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
