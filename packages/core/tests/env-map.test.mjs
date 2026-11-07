import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnvMap, droppedAlternatives } from "../tools/lib/envMap.mjs";

// 2026-11-07：原实现是 `map: { ...MAP }`——无条件写全 5 条。没装 `bat` 的机器上照样生成
// `cat → bat`，于是第 1.5 层拒绝 `cat`，并建议一个不存在的命令：拦得对，替代品是空的。
// 这条用例锁住「替代品不存在就不进表」。
test("环境指纹 map：替代品不存在时不得给出该条目", () => {
  const MAP = { grep: "rg", cat: "bat" };
  assert.deepEqual(buildEnvMap(MAP, ["rg"]), { grep: "rg" });
  assert.deepEqual(buildEnvMap(MAP, ["rg", "bat"]), { grep: "rg", cat: "bat" });
  assert.deepEqual(buildEnvMap(MAP, []), {});
  assert.deepEqual(droppedAlternatives(MAP, ["rg"]), ["cat→bat"]);
});
