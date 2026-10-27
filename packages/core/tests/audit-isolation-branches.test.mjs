/**
 * 审计隔离守卫的两个分支（2026-10-27）
 *
 * 背景：守卫原先只比 `AUDIT.log` 行数，于是**宿主进程在跑 check 期间自己写的那几行**
 * 会被算成"测试污染"（实测 Δ 3 行，逐条核对是 `compaction-watch-ready` + 两条 `handover-inspect`，
 * 时间戳与 `status.json` 的 `started_at` 差 1ms）。假阳性会训练人用 `FG_ALLOW_AUDIT_GROWTH=1` 绕过，
 * 闸门就废了。修法是给审计行加 `run` 批次号，守卫只认本批次。
 *
 * 本文件用**沙箱副本**验证两个分支：把守卫脚本复制到临时目录（`repoRoot` 由脚本自身位置推出，
 * 所以副本天然指向沙箱的 `.focus-guard/AUDIT.log`），绝不动真实审计日志。
 * 没有这两个夹具，"分得开"只是我的说法；有了它，是断言。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./audit-isolation.mjs", import.meta.url));

/** 造一个最小仓库骨架：守卫副本 + 空审计日志 + 一个往日志里写一行的写手 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "fg-iso-"));
  mkdirSync(join(dir, "packages", "core", "tests"), { recursive: true });
  mkdirSync(join(dir, ".focus-guard"), { recursive: true });
  writeFileSync(join(dir, ".focus-guard", "AUDIT.log"), "");
  copyFileSync(GUARD, join(dir, "packages", "core", "tests", "audit-isolation.mjs"));
  writeFileSync(
    join(dir, "writer.mjs"),
    `import { appendFileSync } from 'node:fs'
const mode = process.argv[2]
const run = mode === 'host' ? null : process.env.FG_RUN_ID
appendFileSync('.focus-guard/AUDIT.log', JSON.stringify({ run, action: 'probe' }) + '\\n')
`,
  );
  return dir;
}

function runGuard(dir, mode) {
  const r = spawnSync(
    "node",
    [join(dir, "packages", "core", "tests", "audit-isolation.mjs"), "--wrap", `node writer.mjs ${mode}`],
    { cwd: dir, encoding: "utf8" },
  );
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

describe("审计隔离守卫 · 分得开「宿主写的」与「测试写的」", () => {
  test("分支一：宿主写的（run 为 null）→ 报出来但不阻断", () => {
    const dir = sandbox();
    try {
      const r = runGuard(dir, "host");
      assert.equal(r.code, 0, `不该阻断：\n${r.out}`);
      assert.match(r.out, /另有 1 条来自宿主进程并发写入/, "必须如实报出宿主那一条");
      assert.match(r.out, /PASS/, "宿主写入不能算隔离失效");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("分支二：测试链写的（带本批次号）→ 必须 FAIL", () => {
    const dir = sandbox();
    try {
      const r = runGuard(dir, "test");
      assert.equal(r.code, 1, `必须阻断：\n${r.out}`);
      assert.match(r.out, /本批次 1 条/, "要指出是本批次写的");
      assert.match(r.out, /FAIL：测试链往真实 AUDIT\.log 写了 1 行/, "结论必须是 FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
