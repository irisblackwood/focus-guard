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

// ===== 探测缓存（2026-10-29）=====
// 病根：`wholeFileStage` 每步都调 `detectSearchBackends()`，而它遍历整个 PATH
// （本机 73 目录 × 3 后端 × 4 扩展名 = 876 次 accessSync，单次 13.72ms）。
// 模块头注释写着"每会话探测一次并缓存"，实现里却没有缓存 —— 判定延迟 p95 因此从 2.37 涨到 18.35ms。

test("缓存：连续调用返回同一对象（不再扫 PATH）", () => {
  withEnv({ FG_SEARCH_TOOL: "rg" }, () => {
    sh.resetSearchBackendsCache();
    const first = sh.detectSearchBackends();
    const again = sh.detectSearchBackends();
    assert.equal(again, first, "第二次必须命中缓存（引用相等），否则等于每步重扫 PATH");
  });
});

test("缓存失效：环境变量一变就必须重探（否则测试与真实换环境都会拿到旧结果）", () => {
  sh.resetSearchBackendsCache();
  const rg = withEnv({ FG_SEARCH_TOOL: "rg" }, () => sh.detectSearchBackends());
  const fd = withEnv({ FG_SEARCH_TOOL: "fd" }, () => sh.detectSearchBackends());
  assert.equal(rg.preferred, "rg");
  assert.equal(fd.preferred, "fd", "改 FG_SEARCH_TOOL 后必须重探，不能沿用旧缓存");
});

test("缓存失效：PATH 变了也要重探", () => {
  sh.resetSearchBackendsCache();
  const withPath = withEnv({ FG_SEARCH_TOOL: undefined, PATH: process.env.PATH, FG_SEARCH_BIN_DIR: "" }, () =>
    sh.detectSearchBackends(),
  );
  const noPath = withEnv({ FG_SEARCH_TOOL: undefined, PATH: "", FG_SEARCH_BIN_DIR: "" }, () =>
    sh.detectSearchBackends(),
  );
  assert.equal(noPath.preferred, null, "PATH 清空后必须重探出「无后端」");
  assert.notEqual(withPath, noPath);
});

test("resetSearchBackendsCache：清掉后产生新对象", () => {
  withEnv({ FG_SEARCH_TOOL: "rg" }, () => {
    const a = sh.detectSearchBackends();
    sh.resetSearchBackendsCache();
    const b = sh.detectSearchBackends();
    assert.notEqual(a, b, "reset 后不该复用旧对象");
    assert.deepEqual(a, b, "同一台机器上内容应一致");
  });
});
