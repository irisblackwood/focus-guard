// FocusGuard · 卷宗归属与落点（2026-11-09）
//
// 锁两件事：
//   ① **落点唯一**：`.ai/CASE_FILE.md` 的路径只允许由 `core/state.mjs` 的 `casePath()` 构造。
//      2026-11-08 的真实故障：【五】用 `new URL('../../../../.ai/…', import.meta.url)` 跟着
//      插件安装位置走，装到别处就与【一】【三】【四】分家，用户在自家项目里永远看到空表。
//      修好之后没有任何东西拦着第五个写入点再自拼一次路径——这条断言就是那道拦。
//   ② **所有权**：引擎只拥有它自己写的那几行。【一】的会话检测行由引擎覆盖，
//      人类在同一节里补的注必须原样留着（2026-11-01 红队 A3 修了【三】【四】，漏了【一】）。
//
// 纪律：审计 / 状态 / 卷宗全部重定向到 tmpdir，绝不碰真实工作区。
// 运行：node --test packages/core/tests/case-file-ownership.test.mjs

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const WORK = mkdtempSync(join(tmpdir(), "fg-caseowner-"));
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_STATE_DIR = join(WORK, "state");
process.env.FG_ENV_FP_AUTO = "0"; // 不派生环境指纹子进程，本用例与它无关
delete process.env.FG_CASE_FILE; // 走 projDir 真实分支：卷宗落在 <项目>/.ai/

const { sessionStartListener } = await import("../src/dsh/seams.mjs");
const { CASE_TEMPLATE } = await import("../src/core/constants.mjs");

after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry !== "node_modules") walk(abs, out);
    } else if (/\.(mjs|js)$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

describe("卷宗归属（落点唯一 + 引擎不越界）", () => {
  test("卷宗路径只允许由 core/state.mjs 的 casePath() 构造", () => {
    const files = [
      ...walk(join(ROOT, "packages/core/src")),
      ...walk(join(ROOT, "packages/core/hooks")),
    ];
    const offenders = [];
    for (const abs of files) {
      const rel = relative(ROOT, abs).replace(/\\/g, "/");
      if (rel === "packages/core/src/core/state.mjs") continue; // 唯一真源
      const lines = readFileSync(abs, "utf8").split("\n");
      lines.forEach((line, i) => {
        const s = line.trim();
        if (s.startsWith("*") || s.startsWith("//") || s.startsWith("/*")) return; // 注释里提它没关系
        if (s.includes("CASE_FILE.md")) offenders.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `卷宗路径必须经 casePath()/ensureCaseFile() 构造，禁止自拼：${offenders.join(", ")}`,
    );
  });

  test("会话启动不吞掉【一】里人类补的注", async () => {
    const proj = join(WORK, "proj");
    const cp = join(proj, ".ai", "CASE_FILE.md");
    mkdirSync(dirname(cp), { recursive: true });
    writeFileSync(
      cp,
      CASE_TEMPLATE.replace(
        "（SessionStart 自动写入检测结果并全程复用，人类可在此直接查阅）",
        "（SessionStart 自动写入检测结果并全程复用，人类可在此直接查阅）\n- 人工补注：本机 rg 在 D:/tools/rg.exe，不在 PATH 里",
      ),
    );

    const agent = { session: { header: { id: `caseowner-${process.pid}`, cwd: proj } } };
    await sessionStartListener({ warn: () => {} })({ agent });

    const text = readFileSync(cp, "utf8");
    const section = text.split("### 【一】")[1].split("### 【二】")[0];
    assert.match(section, /人工补注：本机 rg 在 D:\/tools\/rg\.exe/, "人类补注被会话启动吃掉了");
    assert.match(section, /^- OS=/m, "引擎的检测行没写进去");
    assert.equal(
      section.includes("SessionStart 自动写入检测结果并全程复用"),
      false,
      "检测行到位后，模板占位语应被替换掉",
    );
  });
});
