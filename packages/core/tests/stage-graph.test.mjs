import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { orderStages, stageIds, StageCycleError } from "../src/core/stageGraph.mjs";

const ids = (stages) => stageIds(stages);

describe("阶段拓扑排序", () => {
  test("无约束时保持输入顺序（稳定排序——这条不成立会打乱 FG 全部既有行为）", () => {
    const input = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    assert.deepEqual(ids(orderStages(input)), ["a", "b", "c", "d"]);
  });

  test("before 生效：被声明为「先于」的段提前到目标之前", () => {
    // b 无约束且输入序在 c 之前 → 稳定排序下 b 先出；关键是 c 排到了 a 前面
    const input = [{ id: "a" }, { id: "b" }, { id: "c", before: ["a"] }];
    assert.deepEqual(ids(orderStages(input)), ["b", "c", "a"]);
  });

  test("after 生效：被声明为「后于」的段推后", () => {
    const input = [{ id: "a", after: ["c"] }, { id: "b" }, { id: "c" }];
    assert.deepEqual(ids(orderStages(input)), ["b", "c", "a"]);
  });

  test("一对多声明：一个 before 列多个目标", () => {
    const input = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "z", before: ["a", "b", "c"] }];
    assert.deepEqual(ids(orderStages(input)), ["z", "a", "b", "c"]);
  });

  test("未知目标忽略（跨模块声明不能假设对端存在）", () => {
    const input = [{ id: "a", before: ["还没写的段"] }, { id: "b" }];
    assert.deepEqual(ids(orderStages(input)), ["a", "b"]);
  });

  test("自指忽略（before 自己不会成环）", () => {
    const input = [{ id: "a", before: ["a"] }, { id: "b" }];
    assert.deepEqual(ids(orderStages(input)), ["a", "b"]);
  });

  test("成环响亮失败，并点名被阻塞的段", () => {
    const input = [
      { id: "a", before: ["b"] },
      { id: "b", before: ["c"] },
      { id: "c", before: ["a"] },
    ];
    assert.throws(
      () => orderStages(input),
      (e) => e instanceof StageCycleError && /a/.test(e.message) && /b/.test(e.message),
    );
  });

  test("重复 id 直接拒绝（否则 before/after 指向谁不确定）", () => {
    assert.throws(() => orderStages([{ id: "a" }, { id: "a" }]), /重复/);
  });

  test("缺 id 直接拒绝", () => {
    assert.throws(() => orderStages([{}]), /缺少 id/);
    assert.throws(() => orderStages([{ id: "" }]), /缺少 id/);
  });

  test("不修改入参", () => {
    const input = [{ id: "a" }, { id: "b", before: ["a"] }];
    const snapshot = ids(input);
    orderStages(input);
    assert.deepEqual(ids(input), snapshot, "排序必须是纯函数，不能就地改动调用方的数组");
  });

  test("重复声明同一条边不会把入度算两遍（否则合法图被误判成环）", () => {
    const input = [{ id: "a", before: ["b", "b"] }, { id: "b", after: ["a"] }];
    assert.deepEqual(ids(orderStages(input)), ["a", "b"]);
  });
});

describe("FG 的 pre-execute 阶段表", () => {
  test("顺序不变量：9 段 id 与顺序被钉死（改顺序必须同时改这条断言）", async () => {
    const { PRE_STAGE_ORDER } = await import("../src/dsh/pipeline.mjs");
    assert.deepEqual(PRE_STAGE_ORDER, [
      "redline",
      "superpowers",
      "wholeFile",
      "hardCheck",
      "eligibility",
      "valueGate",
      "volume",
      "pollution",
      "risk",
    ]);
  });

  test("语义不变量：红线必须排第一（它是最硬的拒绝，且拒绝不需要任何前置信息）", async () => {
    const { PRE_STAGE_ORDER } = await import("../src/dsh/pipeline.mjs");
    assert.equal(PRE_STAGE_ORDER[0], "redline", "红线被挪到后面 = 别的检查可能先放行");
  });
});
