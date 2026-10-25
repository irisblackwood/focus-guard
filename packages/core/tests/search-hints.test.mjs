import { test } from "node:test";
import assert from "node:assert/strict";

// 检索后端探测与提示协调（2026-10-25）
// 病根：整读闸理由里无条件写死 `xerj search/def` —— 没装 XERJ 的用户照做必然失败（假提示）。
// 本组锁：① 强制指定后端 ② 无后端时的降级提示 ③ 安装提醒只给一次 ④ 提示里不出现未安装的工具。

const sh = await import("../src/dsh/search-hints.mjs");

function withEnv(vars, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("FG_SEARCH_TOOL 指定后端：提示里出现该后端命令", () => {
  withEnv({ FG_SEARCH_TOOL: "rg" }, () => {
    const b = sh.detectSearchBackends();
    assert.equal(b.preferred, "rg");
    assert.equal(b.forced, true);
    assert.match(sh.retrievalHint(b), /rg -n/);
  });
});

test("指定 xerj：提示走 xerj search/def", () => {
  withEnv({ FG_SEARCH_TOOL: "xerj" }, () => {
    assert.match(sh.retrievalHint(sh.detectSearchBackends()), /xerj search/);
  });
});

test("完全无后端（PATH 清空 + 不强制）：降级提示不含未安装工具名，且给安装提醒", () => {
  withEnv({ FG_SEARCH_TOOL: undefined, PATH: "", FG_SEARCH_BIN_DIR: "" }, () => {
    const b = sh.detectSearchBackends();
    assert.equal(b.preferred, null);
    const hint = sh.retrievalHint(b);
    assert.doesNotMatch(hint, /xerj search|rg -n|fd -e/, "不得提示未安装的工具");
    assert.match(hint, /offset\/limit/);
    const tip = sh.installReminder(b);
    assert.ok(tip && tip.includes("FG_SEARCH_TOOL"), "应提示可用 FG_SEARCH_TOOL 协调其它检索插件");
  });
});

test("有后端时不给安装提醒", () => {
  withEnv({ FG_SEARCH_TOOL: "fd" }, () => {
    assert.equal(sh.installReminder(sh.detectSearchBackends()), null);
  });
});

test("describeBackends 可读输出", () => {
  withEnv({ FG_SEARCH_TOOL: "rg" }, () => {
    assert.match(sh.describeBackends(), /首选=rg/);
  });
});
