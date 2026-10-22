import { test } from "node:test";
import assert from "node:assert/strict";

// 重复被拦（2026-10-22，人类反馈"工作流没做好"）
// 实测浪费：8 任务那轮被拦 7 条后模型仍重试同一条，多出 4 个 step（每步重读全上下文）。
// 本组锁：① 第 1 次不改文案；② 第 2 次起加"重复被拦 ×N"；③ 按闸类型给不同的"换法"；④ 不改判定。

const rg = await import("../src/dsh/repeatGuard.mjs");

const exec = (tool, args) => ({ sessionId: "s1", name: tool, arguments: args });
const deny = (reason) => ({ kind: "deny", reason });

test("第 1 次被拦：文案原样（不制造噪音）", () => {
  rg.resetRepeatCounts();
  const d = deny("focus-guard-native: 整文件闸——x.mjs 超过 300 行");
  const out = rg.augmentDeny(exec("read", { file_path: "x.mjs" }), d);
  assert.equal(out.reason, d.reason);
  assert.equal(out.repeat, undefined);
});

test("第 2 次同一条：加「重复被拦 ×2」+ 换法（不再重复原话）", () => {
  rg.resetRepeatCounts();
  const e = exec("read", { file_path: "x.mjs" });
  const d = deny("focus-guard-native: 整文件闸——x.mjs 超过 300 行");
  rg.augmentDeny(e, d);
  const out = rg.augmentDeny(e, d);
  assert.match(out.reason, /重复被拦 ×2/);
  assert.match(out.reason, /xerj search/);
  assert.match(out.reason, /原始理由/);
  assert.equal(out.repeat, 2);
});

test("换法按闸类型区分：Grep / 取证 / 红线 各给不同路径", () => {
  assert.match(rg.altHint("体积刺客——Grep 未收窄"), /include/);
  assert.match(rg.altHint("第3层状态校验：卷宗无取证记录"), /先用 read/);
  assert.match(rg.altHint("命中绝对红线「drop-database」"), /fg_appeal/);
  assert.match(rg.altHint("该工具需先调 fg_apply 申请授权"), /fg_apply/);
});

test("不同参数不算重复；allow/ask 不改写", () => {
  rg.resetRepeatCounts();
  const d = deny("整文件闸");
  rg.augmentDeny(exec("read", { file_path: "a.mjs" }), d);
  const other = rg.augmentDeny(exec("read", { file_path: "b.mjs" }), d);
  assert.equal(other.repeat, undefined, "参数不同不应计为重复");
  const allow = rg.augmentDeny(exec("read", { file_path: "a.mjs" }), { kind: "allow" });
  assert.equal(allow.kind, "allow");
  const ask = rg.augmentDeny(exec("read", { file_path: "a.mjs" }), { kind: "ask", reason: "r" });
  assert.equal(ask.reason, "r", "ask 不改写");
});
