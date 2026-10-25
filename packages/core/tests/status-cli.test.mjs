import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// status CLI 与 status.json 的字段对齐（2026-10-25）
// 病根：KPI 可见化把 kpi/delegate_budget 写进 status.json，但 `status.mjs` 没读 →
// 人类跑 `npm run status` 依旧看不到。本组锁：文件有则 CLI 必须显示。

const WORK = mkdtempSync(join(tmpdir(), "fg-status-"));
const file = join(WORK, "status.json");
// Windows 上 URL.pathname 是 `/E:/...`，直接当路径会拼成 `E:\E:\...` → 必须 fileURLToPath。
const CLI = fileURLToPath(new URL("../src/dsh/status.mjs", import.meta.url));

function runCli() {
  return execFileSync(process.execPath, [CLI, "--file", file], { encoding: "utf8" });
}

test("status.json 带 kpi → 一行输出里包含 KPI 与委托", () => {
  writeFileSync(
    file,
    JSON.stringify({
      status: "ALIVE",
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      pid: process.pid,
      stale_after_ms: 60000,
      modules_ok: "15/15",
      degraded: [],
      kpi: -640,
      delegate_budget: 19,
      kpi_at: new Date().toISOString(),
    }),
  );
  const out = runCli();
  assert.match(out, /KPI -640/);
  assert.match(out, /委托 19/);
});

test("无 kpi 字段时兼容（不显示、不报错）", () => {
  writeFileSync(
    file,
    JSON.stringify({
      status: "ALIVE",
      last_heartbeat: new Date().toISOString(),
      stale_after_ms: 60000,
      modules_ok: "15/15",
    }),
  );
  const out = runCli();
  assert.doesNotMatch(out, /KPI/);
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
