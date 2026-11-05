// 审计日志保留判据（2026-11-03）
//
// 起因：人类报「AUDIT.log 有极旧数据都不清理」。实测 27 天写 2.76 MB / 10,256 条，
// 首条 2026-10-06 的记录一直留在活动日志里——因为轮转只有体积判据（5 MB），
// 按当时速率约 45–50 天才轮到一次。**体积约束磁盘，年龄约束可读性。**
//
// 本文件只锁一条红路径：首条超龄 → 必须归档，哪怕体积远未到上限。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_MAX_BYTES, rotateAuditIfNeeded } from "../src/core/audit-writer.mjs";

test("审计轮转：首条超龄即归档（不依赖体积）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-audit-age-"));
  try {
    const file = join(dir, "AUDIT.log");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(file, `${JSON.stringify({ ts: old, action: "rules-registered" })}\n`);

    const dest = rotateAuditIfNeeded(file, AUDIT_MAX_BYTES);

    assert.ok(dest, "首条 31 天前、体积仅数十字节，仍应轮转");
    assert.equal(readdirSync(join(dir, "archive")).length, 1, "应归档一份到 archive/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
