/**
 * SessionStart 落卷宗：**只给载荷 cwd、不给环境变量**。
 *
 * 2026-11-15 新增。这条路径此前从未被跑过——作者机的宿主一直在环境里设
 * `CLAUDE_PROJECT_DIR`，而 `acceptance.test.mjs` 又把它显式置空、改用
 * `ZCODE_PROJECT_DIR` 注入。于是「两个都没设」时 `projectDir()` 返回 null、
 * `if (projDir)` 整段跳过、`.ai/CASE_FILE.md` 静默不生成，而测试全绿。
 *
 * 载荷里的 `cwd` 一直都在（桥的 `base()` 兜底是 `process.cwd()`），
 * 只是引擎从来没读过它——这条用例就钉住「必须读」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { statePath } from "../src/core/state.mjs";

const GUARD = fileURLToPath(new URL("../hooks/guard.mjs", import.meta.url));
const SID = `case-cwd-${process.pid}-${Date.now()}`;

test("SessionStart：环境变量都没有时，按载荷 cwd 落卷宗", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-case-cwd-"));
  try {
    const env = { ...process.env };
    // 三个「工作区根」变量全部清掉：本用例要验的就是它们都不在时的行为。
    for (const k of ["ZCODE_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "FG_CASE_FILE"]) delete env[k];
    const p = spawnSync("node", [GUARD, "start"], {
      input: JSON.stringify({ session_id: SID, cwd: dir, hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      env,
    });
    assert.equal(p.status, 0, `guard.mjs start 应正常退出：${p.stderr}`);

    const cf = join(dir, ".ai", "CASE_FILE.md");
    assert.ok(existsSync(cf), "载荷带了 cwd，卷宗就该落在那个目录，不能因为缺环境变量就整段跳过");
    const text = readFileSync(cf, "utf8");
    // 只有模板还不够——【一】必须是**真检测结果**，否则等于只创建了个空壳。
    assert.match(text, /^### 【一】/m, "模板结构应在");
    assert.match(text, /^- OS=/m, "【一】要写进真环境行，不能只留占位符");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(statePath(SID), { force: true });
  }
});
