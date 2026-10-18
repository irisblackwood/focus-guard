import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseCaseRows, checkPaths } = await import("../tools/verify-case-paths.mjs");

test("parseCaseRows：抽出【三】表格行，跳过表头/分隔行与后续章节", () => {
  const text = [
    "### 【二】业务依赖",
    "| 依赖名 | 版本 |",
    "### 【三】侦查取证记录（插件自动追加）",
    "| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |",
    "|---|---|---|---|---|---|---|---|",
    "| E:\\a\\b.mjs | 2026-01-01T00:00:00.000Z | 1 | 2 | xx | - | - | read |",
    "| c.md | 2026-01-02T00:00:00.000Z | 1 | 2 | xx | - | - | read |",
    "### 【四】额度台账",
    "| d | e |",
  ].join("\n");
  const rows = parseCaseRows(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].path, "E:\\a\\b.mjs");
  assert.equal(rows[0].readAt, "2026-01-01T00:00:00.000Z");
  assert.equal(rows[1].path, "c.md");
});

test("checkPaths：存在/失效分流，相对路径按给定 root 解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-case-paths-"));
  writeFileSync(join(dir, "exists.txt"), "x");
  const { ok, missing } = checkPaths(
    [{ path: "exists.txt", readAt: "", line: 1 }, { path: "nope-missing-xyz.txt", readAt: "", line: 2 }],
    dir,
  );
  assert.equal(ok.length, 1);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, "nope-missing-xyz.txt");
  rmSync(dir, { recursive: true, force: true });
});
