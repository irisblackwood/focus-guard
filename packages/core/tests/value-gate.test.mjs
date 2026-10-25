import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 改动面闸（2026-10-25）
// 人类判据："改大量文件只换来一个小彩灯"——判的是**改动面 × 收益量级**，不是 token ROI。
// 本组锁：① 新建敏感文件触发一次 ② 重试即放行 ③ 已存在/非敏感路径不走本闸 ④ 加依赖触发
//         ⑤ 人类指令已声明收益时不介入。
// 注意：其他闸（取证/资格）也可能拒同一条调用，所以断言只看理由里有没有"改动面闸"。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-vg-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";
const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");
const vg = await import("../src/dsh/value-gate.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-vg-"));
writeFileSync(join(DIR, "existing.mjs"), "x");
const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });
let seq = 0;

function call(sid, tool, args) {
  return listener(
    { sessionId: sid, name: tool, arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    allow,
  );
}

function seed(prompt = "") {
  const sid = `vg-${process.pid}-${(seq += 1)}`;
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, turnPrompt: prompt });
  return sid;
}

const isValueGate = (r) => String((r && r.reason) || "").includes("改动面闸");

test("新建 src/ 下不存在的文件 → 第一次拒，理由含三行模板", async () => {
  const sid = seed();
  const out = await call(sid, "write", { file_path: join(DIR, "src", "new.mjs"), content: "x" });
  assert.equal(out.kind, "deny");
  assert.ok(isValueGate(out));
  assert.match(String(out.reason), /收益/);
  assert.match(String(out.reason), /替代/);
});

test("同一会话重试即放行（只拒一次）", async () => {
  const sid = seed();
  const first = await call(sid, "write", { file_path: join(DIR, "src", "a.mjs"), content: "x" });
  assert.ok(isValueGate(first));
  const second = await call(sid, "write", { file_path: join(DIR, "src", "a.mjs"), content: "x" });
  assert.ok(!isValueGate(second), "第二次不得再走改动面闸");
});

test("已存在文件 / 非敏感路径 → 不走改动面闸", async () => {
  const a = await call(seed(), "write", { file_path: join(DIR, "existing.mjs"), content: "y" });
  assert.ok(!isValueGate(a));
  const b = await call(seed(), "write", { file_path: join(DIR, "docs", "new.md"), content: "y" });
  assert.ok(!isValueGate(b));
});

test("加依赖触发；人类已声明收益时不介入", async () => {
  const dep = await call(seed(), "pwsh", { command: "npm install left-pad" });
  assert.ok(isValueGate(dep), "加依赖应走改动面闸");
  const declared = await call(seed("收益：用户可见的安装报错减少，可测"), "pwsh", { command: "npm install left-pad" });
  assert.ok(!isValueGate(declared), "已声明收益时不得再拦");
});

test("promptDeclaresBenefit 判定", () => {
  assert.equal(vg.promptDeclaresBenefit("加个功能"), false);
  assert.equal(vg.promptDeclaresBenefit("收益：减少误拦，用户可见"), true);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
