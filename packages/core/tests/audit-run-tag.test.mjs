/**
 * 审计行的运行批次号（`run` 字段，2026-10-27）
 *
 * 为什么需要它：审计隔离守卫原先只比行数，而**宿主进程在跑 check 期间自己也会写**
 * `AUDIT.log`（实测 Δ 3 行，逐条核对是 `compaction-watch-ready` 与两条 `handover-inspect`，
 * 时间戳与 `status.json` 的 `started_at` 差 1ms）。分不开 → 守卫报假阳性 →
 * 人会开始用 `FG_ALLOW_AUDIT_GROWTH=1` 绕过，闸门就废了。
 *
 * 修法：`audit()` 落一行 `run`（取 `FG_RUN_ID`），守卫给子进程注入批次号，
 * 只把带本批次号的行算作"测试链写的"。本文件锁住这条契约。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX = mkdtempSync(join(tmpdir(), "fg-audit-run-"));
const FILE = join(SANDBOX, "AUDIT.log");
process.env.FG_AUDIT_FILE = FILE;
process.on("exit", () => rmSync(SANDBOX, { recursive: true, force: true }));

// 动态 import：auditTarget() 在首次调用时读 FG_AUDIT_FILE 并缓存，必须先设环境再加载
const { audit } = await import("../src/core/audit.mjs");

function readLines() {
  try {
    return readFileSync(FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("审计行 · 运行批次号 run", () => {
  test("未设 FG_RUN_ID → run 为 null（宿主进程的正常形态）", () => {
    delete process.env.FG_RUN_ID;
    audit("sid-host", "probe", { action: "probe-no-run" });
    const line = readLines().find((r) => r.action === "probe-no-run");
    assert.ok(line, "审计行未写入");
    assert.equal(line.run, null);
  });

  test("设了 FG_RUN_ID → run 等于该值（守卫靠它认出「测试链写的」）", () => {
    process.env.FG_RUN_ID = "iso-test-123";
    audit("sid-test", "probe", { action: "probe-with-run" });
    const line = readLines().find((r) => r.action === "probe-with-run");
    assert.ok(line, "审计行未写入");
    assert.equal(line.run, "iso-test-123");
    delete process.env.FG_RUN_ID;
  });

  test("加字段不得挤掉原有字段（因果链与假留痕防线都靠它们）", () => {
    const line = readLines().find((r) => r.action === "probe-with-run");
    for (const k of ["ts", "session", "seq", "chain", "ref", "action", "trigger", "level", "evidence", "pardon"])
      assert.ok(k in line, `审计行缺字段 ${k}`);
  });
});
