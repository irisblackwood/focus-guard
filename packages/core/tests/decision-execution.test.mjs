import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 决策-执行一致性探针（2026-10-22）
// 断言"返回 deny 但工具其实执行了"这类 bug 不存在：用一个真实执行器模拟宿主派发——
// deny ⇒ 执行器不得被调用、目标文件字节不变；allow ⇒ 执行器被调用、目标文件确实改变。
// 注意：这不是"FG 副作用探针"（FG 只做判定），而是**判定与派发的一致性命门**。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-dx-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-dx-"));
const TARGET = join(DIR, "target.txt");
writeFileSync(TARGET, "ORIGINAL\n");

const listener = preExecuteListener({ warn: () => {} });
let seq = 0;

/** 走一遍判定；只有 allow 才真正执行 executor（模拟宿主）。 */
async function dispatch(tool, args, executor) {
  const sid = `dx-${process.pid}-${(seq += 1)}`;
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  const decision = await listener(
    { sessionId: sid, name: tool, arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    () => ({ kind: "allow" }),
  );
  const kind = (decision && decision.kind) || "allow";
  const executed = kind === "allow" ? (executor(), true) : false;
  rmSync(statePath(sid), { force: true });
  return { kind, executed };
}

test("deny ⇒ 执行器未被调用，目标文件字节不变", async () => {
  const before = readFileSync(TARGET, "utf8");
  const r = await dispatch("write", { file_path: TARGET, content: "MUTATED" }, () => writeFileSync(TARGET, "MUTATED"));
  assert.equal(r.kind, "deny");
  assert.equal(r.executed, false, "deny 后不得执行");
  assert.equal(readFileSync(TARGET, "utf8"), before, "目标文件必须未被修改");
});

test("先读取再写 ⇒ allow 且执行器被调用、文件确实改变", async () => {
  saveState(statePath("dx-seed"), { fused: false, probation: false, readSet: {}, caseCache: {} });
  // 先记录一次读（模拟宿主 read 工具成功）
  const sid = `dx-${process.pid}-read`;
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  await listener(
    { sessionId: sid, name: "read", arguments: { file_path: TARGET }, agent: { session: { header: { id: sid, cwd: DIR } } } },
    () => ({ kind: "allow" }),
  );
  // 同会话再写
  const decision = await listener(
    { sessionId: sid, name: "write", arguments: { file_path: TARGET, content: "MUTATED\n" }, agent: { session: { header: { id: sid, cwd: DIR } } } },
    () => ({ kind: "allow" }),
  );
  const kind = (decision && decision.kind) || "allow";
  assert.equal(kind, "allow", "读过之后应放行");
  writeFileSync(TARGET, "MUTATED\n");
  assert.equal(readFileSync(TARGET, "utf8"), "MUTATED\n");
  rmSync(statePath(sid), { force: true });
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
