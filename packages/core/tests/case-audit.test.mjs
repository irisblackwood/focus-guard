// 卷宗体检 + 半衰期（3.4.0）
//
// 两条被测物各自只需一条红路径：
//   · auditCase  —— 悬空行必须报（这是它唯一会阻断的情形）
//   · halfLifeOf —— 档位边界必须连续（这是替换阶梯的**唯一理由**）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCase } from "../tools/case-audit.mjs";
import { halfLifeOf, retention } from "../src/core/state.mjs";
import { TTL_CEIL, TTL_FLOOR } from "../src/core/constants.mjs";

const ROW = "| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |";
const SEP = "|---|---|---|---|---|---|---|---|";

/** 造一个只含【三】的临时卷宗，返回临时目录。FG_CASE_FILE 让 casePath 指向它。 */
function fixture(rows) {
  const dir = mkdtempSync(join(tmpdir(), "fg-case-audit-"));
  writeFileSync(join(dir, "CASE_FILE.md"), `# 卷宗\n\n### 【三】侦查记录\n\n${[ROW, SEP, ...rows].join("\n")}\n`);
  process.env.FG_CASE_FILE = join(dir, "CASE_FILE.md");
  return dir;
}

test("悬空行必须报：卷宗指向不存在的文件", () => {
  const dir = fixture(["| /definitely/not/here.mjs | 2026-10-31T00:00:00.000Z | 0 | 0 | - | n=0; last=- | | mtime+size |"]);
  try {
    const r = auditCase(dir, { now: Date.parse("2026-10-31T00:00:00.000Z") });
    assert.equal(r.total, 1);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].kind, "ghost");
  } finally {
    delete process.env.FG_CASE_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("半衰期在档位边界上连续：6.99 天与 7.01 天相差不到 1 小时", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const at = (days) => ({ lastChange: now - days * 86400e3, readAt: now, changes: 0 });
  const a = halfLifeOf(at(6.99), now);
  const b = halfLifeOf(at(7.01), now);
  // 旧阶梯在这一步从 2h 跳到 24h（差 22h）。半衰期必须落在同一个量级上。
  assert.ok(Math.abs(a - b) < 3600e3, `跳变 ${(Math.abs(a - b) / 3600e3).toFixed(1)}h 仍然太大`);
  assert.ok(a >= TTL_FLOOR && a <= TTL_CEIL);
});

test("保持度随时间单调下降，跨过半衰点即 < 0.5", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  // 1 小时前变过 → S 被夹到下限 2h；读了 3 小时 → R = 0.5^1.5 ≈ 0.35
  const rec = { lastChange: now - 3600e3, readAt: now - 3 * 3600e3, changes: 0 };
  const fresh = retention({ ...rec, readAt: now }, now);
  const old = retention(rec, now);
  assert.equal(fresh, 1);
  assert.ok(old < fresh);
  assert.ok(old < 0.5, `读了 3h、半衰期 2h，R 应已过半衰点，实际 ${old.toFixed(3)}`);
});
