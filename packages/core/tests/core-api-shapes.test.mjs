import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 母版层 API 形态锁定（2026-10-25 模块普查）
// 发现：outputGate 三个判定函数返回**三种不同形态**——不是 bug，但极易被调用方误用
// （我自己探针就先写错了两处）。本组把形态钉死：
//   judgeReadGate  → 字符串 'exempt' | 'deny' | 'allow'
//   judgeGrepGate  → 对象 { action: 'allow' | 'deny', reason }
//   judgeCatGate   → 字符串 'allow' | 'deny'
//   rotateAuditIfNeeded → 轮转时返回归档路径字符串；无需轮转返回 null

const og = await import("../src/core/outputGate.mjs");
const aw = await import("../src/core/audit-writer.mjs");

test("judgeReadGate 返回字符串三态", () => {
  assert.equal(typeof og.judgeReadGate({ bytes: 300 * 1024, gateBytes: 200 * 1024, turnPrompt: "" }), "string");
  assert.equal(og.judgeReadGate({ bytes: 300 * 1024, gateBytes: 200 * 1024, turnPrompt: "审计这次重构" }), "exempt");
  assert.equal(og.judgeReadGate({ bytes: 10, gateBytes: 200 * 1024, turnPrompt: "" }), "allow");
});

test("judgeGrepGate 返回 {action, reason}", () => {
  const d = og.judgeGrepGate({ broadDir: true });
  assert.equal(d.action, "deny");
  assert.equal(typeof d.reason, "string");
  assert.equal(og.judgeGrepGate({}).action, "allow");
});

test("judgeCatGate 返回字符串二态", () => {
  assert.equal(og.judgeCatGate("cat a.mjs"), "deny");
  assert.equal(og.judgeCatGate("cat a.mjs | head -20"), "allow");
  assert.equal(og.judgeCatGate("bat a.mjs"), "allow");
});

test("rotateAuditIfNeeded：需轮转返回路径，无需轮转返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-rot-"));
  const log = join(dir, "AUDIT.log");
  for (let i = 0; i < 30; i += 1) appendFileSync(log, JSON.stringify({ i, pad: "x".repeat(600) }) + "\n");
  const archived = aw.rotateAuditIfNeeded(log, 5000);
  assert.equal(typeof archived, "string", "轮转应返回归档路径");
  assert.ok(existsSync(join(dir, "archive")), "应创建 archive 目录");
  assert.ok(readdirSync(join(dir, "archive")).length >= 1);
  const again = aw.rotateAuditIfNeeded(log, 5 * 1024 * 1024);
  assert.equal(again, null, "未超限应返回 null");
  rmSync(dir, { recursive: true, force: true });
});
