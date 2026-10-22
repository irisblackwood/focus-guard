// FocusGuard · 体积闸判定内核（core/outputGate.mjs）
//
// 2026-10-22 新建：体积闸判定此前在两条适配路径各写一份（hooks/guard.mjs 与
// src/dsh/pipeline.mjs），判据已经开始分叉。本文件把内核行为钉死，防止再次漂移。
//
// 注意本文件测的是**判定**，不是参数提取——两个宿主的工具 schema 不同：
//   · Claude Code / ZCode 的 Grep 有 output_mode / head_limit → contentUnlimited
//   · DSH 的 Grep 只有 {pattern, path, include}            → broadDir
// 参数怎么翻译成这两个布尔量，由各适配层的用例负责（gates.test.mjs / decision-bench）。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { judgeReadGate, judgeGrepGate, judgeCatGate } = await import("../src/core/outputGate.mjs");

const GATE = 50 * 1024; // 与 constants.mjs 的 OUTPUT_GATE_BYTES 同值

describe("体积闸内核 · Read 整读", () => {
  test("未超阈值放行", () => {
    assert.equal(judgeReadGate({ bytes: GATE, gateBytes: GATE }), "allow", "等于阈值不算超");
    assert.equal(judgeReadGate({ bytes: 1024, gateBytes: GATE }), "allow");
  });

  test("超阈值拦截", () => {
    assert.equal(judgeReadGate({ bytes: GATE + 1, gateBytes: GATE }), "deny");
  });

  test("审计类任务豁免（留痕不罚）", () => {
    for (const p of ["审计这个模块", "盘点全部文件", "审查一下代码"]) {
      assert.equal(judgeReadGate({ bytes: GATE + 1, gateBytes: GATE, turnPrompt: p }), "exempt", p);
    }
  });

  test("豁免只在超阈值时才有意义——小文件本来就不拦", () => {
    assert.equal(judgeReadGate({ bytes: 10, gateBytes: GATE, turnPrompt: "审计" }), "allow");
  });

  test("取不到大小（0 / NaN）时放行，不因 ENOENT 误拦", () => {
    assert.equal(judgeReadGate({ bytes: 0, gateBytes: GATE }), "allow");
    assert.equal(judgeReadGate({ bytes: NaN, gateBytes: GATE }), "allow");
  });

  test("非审计提示不豁免", () => {
    assert.equal(judgeReadGate({ bytes: GATE + 1, gateBytes: GATE, turnPrompt: "帮我改个 bug" }), "deny");
  });
});

describe("体积闸内核 · Grep 收窄", () => {
  test("目录级未收窄 → 拦，理由指向 include", () => {
    const r = judgeGrepGate({ broadDir: true });
    assert.equal(r.action, "deny");
    assert.match(r.reason, /include/);
  });

  test("正文模式未限量 → 拦，理由宿主中立（不写死 head_limit/files_with_matches）", () => {
    const r = judgeGrepGate({ contentUnlimited: true });
    assert.equal(r.action, "deny");
    assert.match(r.reason, /限量/);
    assert.doesNotMatch(r.reason, /head_limit|files_with_matches/, "母版文案不得含宿主专属参数名");
  });

  test("两种语义都不成立 → 放行", () => {
    assert.equal(judgeGrepGate({}).action, "allow");
    assert.equal(judgeGrepGate({ broadDir: false, contentUnlimited: false }).action, "allow");
  });

  test("同时成立时优先报目录级理由（DSH 侧更常见的那条）", () => {
    assert.match(judgeGrepGate({ broadDir: true, contentUnlimited: true }).reason, /include/);
  });

  test("放行时 reason 为空串，不残留上一分支文案", () => {
    assert.equal(judgeGrepGate({}).reason, "");
  });
});

describe("体积闸内核 · 裸 cat/type", () => {
  test("裸 cat / type / Get-Content 拦", () => {
    assert.equal(judgeCatGate("cat big.log"), "deny");
    assert.equal(judgeCatGate("type big.log"), "deny");
    assert.equal(judgeCatGate("Get-Content big.log"), "deny");
  });

  test("有管道 / 重定向 / 限量即放行", () => {
    assert.equal(judgeCatGate("cat big.log | head -20"), "allow");
    assert.equal(judgeCatGate("cat a > b"), "allow");
    assert.equal(judgeCatGate("Get-Content x -TotalCount 20"), "allow");
    assert.equal(judgeCatGate("Get-Content x -First 20"), "allow");
    assert.equal(judgeCatGate("Get-Content x -Tail 20"), "allow");
  });

  test("非 cat 类命令一律放行", () => {
    assert.equal(judgeCatGate("ls -la"), "allow");
    assert.equal(judgeCatGate("git status"), "allow");
    assert.equal(judgeCatGate(""), "allow");
    assert.equal(judgeCatGate(undefined), "allow");
  });

  test("命令中段出现的 cat 也认（分号 / 与或之后）", () => {
    assert.equal(judgeCatGate("echo x; cat big.log"), "deny");
    assert.equal(judgeCatGate("true && cat big.log"), "deny");
  });

  test("只是参数里含 cat 字样的命令不误伤", () => {
    assert.equal(judgeCatGate("grep cat README.md"), "allow");
    assert.equal(judgeCatGate("echo 'cat big.log'"), "allow");
  });
});
