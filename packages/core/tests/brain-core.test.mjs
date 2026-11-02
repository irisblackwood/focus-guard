/**
 * 脑数据层的判据（2026-11-02）。
 *
 * 只测三件事，都是"错了会静默"的那种：
 *   ① 分区映射——错了会让脑干的东西长到半球上，而画面看上去仍然"正常"。
 *   ② 遗忘曲线——错了不会报错，只会让强度算成别的数，几个月后才发现不对。
 *   ③ 增量幂等——错了就是**每次跑都把同一批事件再数一遍**，强度虚高，而且日志越长越离谱。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEvent, classify, decayTo, emptyIndex, isNoise, loadConfig, prune, readNewLines, regionOf,
} from "../tools/lib/brain-core.mjs";
import { inferRelations, pmi } from "../tools/lib/brain-relate.mjs";

test("分区：条号与高危进脑干，工具与机械动作进小脑，代码进左脑，文档进右脑", () => {
  assert.equal(regionOf("rule", "第43条"), "stem");
  assert.equal(regionOf("action", "deny"), "stem");
  assert.equal(regionOf("action", "stall-fuse"), "stem");
  assert.equal(regionOf("tool", "Bash"), "cerebellum");
  assert.equal(regionOf("action", "reset-fired"), "cerebellum");
  assert.equal(regionOf("file", "packages/core/src/core/state.mjs"), "left");
  assert.equal(regionOf("file", "packages/core/docs/RULES.md"), "right");
});

test("分区：代码靠扩展名认，不靠目录——根目录的 .mjs 也是代码", () => {
  // 旧判据要求路径里有 src|tools|hooks|tests，于是 cleanup.mjs（228 次，最大的文件实体）
  // 被当成"叙事"扔进右脑，按 30 天半衰期遗忘。
  assert.equal(regionOf("file", "cleanup.mjs"), "left");
  assert.equal(regionOf("file", "packages/core/docs/HANDOFF.md"), "right");
});

test("分区：触发器是判据的实例，不落叙事；屈折变化也能命中", () => {
  // 旧判据没有 trigger 分支，22 个触发器全落右脑，high-risk-rm（1,729 次）被当故事忘掉。
  assert.equal(regionOf("trigger", "high-risk-rm"), "stem");
  assert.equal(regionOf("trigger", "evidence-gate"), "stem");
  assert.equal(classify("trigger", "ttl:turn").why, "fallback-trigger");
  assert.equal(regionOf("trigger", "ttl:turn"), "left");
  // grants-swept 的 swept 不命中 sweep（硬正则的屈折问题）
  assert.equal(regionOf("action", "grants-swept"), "cerebellum");
  assert.equal(regionOf("action", "reject-no-form"), "stem");
});

test("分区：认不出来就说不认识，不硬猜；配置能追加词表并压过默认", () => {
  const c = classify("action", "zzz-unknown-thing");
  assert.equal(c.why, "fallback");
  assert.equal(c.r, "right");

  const cfg = loadConfig(null);
  cfg.lexicon.stem = [...cfg.lexicon.stem, "zzz"];
  assert.equal(classify("action", "zzz-unknown-thing", cfg).r, "stem");

  // rules 最优先：连"条号必进脑干"也能被人工推翻
  const ruled = { ...cfg, rules: [{ re: "^第99条$", region: "right" }] };
  assert.equal(classify("rule", "第99条", ruled).r, "right");
  assert.equal(classify("rule", "第43条", ruled).r, "stem");
});

test("噪音：内置判据挡临时路径，配置只能追加、关不掉内置的", () => {
  assert.equal(isNoise("C:/Users/x/AppData/Local/Temp/a.txt"), true);
  assert.equal(isNoise("src/core/state.mjs"), false);
  assert.equal(isNoise("vendor/thing.js", ["vendor/"]), true);
  assert.equal(isNoise("C:/tmp/x.txt", []), true);
});

test("遗忘曲线：正好过一个半衰期，强度减半", () => {
  const s = decayTo(100, "2026-01-01T00:00:00Z", 30, Date.parse("2026-01-31T00:00:00Z"));
  assert.ok(Math.abs(s - 50) < 0.01, `期望 50，实得 ${s}`);
});

test("脑干永不遗忘：半衰期为无穷时，四年后强度仍是原值", () => {
  const s = decayTo(100, "2026-01-01T00:00:00Z", Infinity, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(s, 100);
});

test("增量幂等：同一份日志读第二遍，返回 0 行（不重复计数）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-brain-"));
  try {
    const log = join(dir, "AUDIT.log");
    writeFileSync(log, `${JSON.stringify({ ts: "2026-10-01T00:00:00Z", action: "deny", tool: "Bash", evidence: "src/a.mjs" })}\n`);
    const idx = emptyIndex();
    const first = readNewLines(log, undefined);
    assert.equal(first.lines.length, 1);
    applyEvent(idx, JSON.parse(first.lines[0]), "/repo", Date.now());
    idx.cursors[log] = first.cursor;
    assert.equal(idx.seen, 1);

    const second = readNewLines(log, idx.cursors[log]);
    assert.equal(second.lines.length, 0, "第二遍不该再读到行");
    assert.equal(idx.seen, 1, "累计事件数不该涨");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("修剪：超过一年未动且强度见底的实体被遗忘，新的留下", () => {  const idx = emptyIndex();
  idx.entities["file:old.mjs"] = { t: "file", n: "old.mjs", r: "right", c: 1, f: "2024-01-01T00:00:00Z", l: "2024-01-01T00:00:00Z", s: 1, x: [] };
  idx.entities["file:new.mjs"] = { t: "file", n: "new.mjs", r: "right", c: 1, f: "2026-11-01T00:00:00Z", l: "2026-11-01T00:00:00Z", s: 1, x: [] };
  const dropped = prune(idx, Date.parse("2026-11-02T00:00:00Z"));
  assert.equal(dropped, 1);
  assert.ok(!idx.entities["file:old.mjs"], "两年前的一闪而过应该被忘掉");
  assert.ok(idx.entities["file:new.mjs"], "昨天的必须留下");
});

test("推断边：两个从未同现的实体，共享两个中间物就自动连上", () => {
  const nodes = [
    { i: 0, n: "src/a.mjs", t: "file" }, { i: 1, n: "src/b.mjs", t: "file" },
    { i: 2, n: "src/c.mjs", t: "file" }, { i: 3, n: "src/d.mjs", t: "file" },
  ];
  const edges = [
    { s: 0, t: 2, k: "co", w: 1, v: 1 }, { s: 0, t: 3, k: "co", w: 1, v: 1 },
    { s: 1, t: 2, k: "co", w: 1, v: 1 }, { s: 1, t: 3, k: "co", w: 1, v: 1 },
  ];
  const inf = inferRelations(nodes, edges, { maxInf: 100 });
  const ab = inf.find((e) => e.s === 0 && e.t === 1);
  assert.ok(ab, "0 与 1 从未同现，但共享中间物 2 和 3，应当被推断连上");
  assert.equal(ab.k, "inf", "推断边必须打上 inf 标记，否则与事实边混为一谈");
  assert.ok(ab.parts && typeof ab.parts.aa === "number", "必须带分项拆解，否则界面上一句'分 0.86'等于没说");
});

test("推断边：只共享一个中间物不算关系", () => {
  const nodes = [{ i: 0, n: "src/a.mjs", t: "file" }, { i: 1, n: "src/b.mjs", t: "file" }, { i: 2, n: "src/c.mjs", t: "file" }];
  const edges = [
    { s: 0, t: 2, k: "co", w: 1, v: 1 },
    { s: 1, t: 2, k: "co", w: 1, v: 1 },
  ];
  assert.equal(inferRelations(nodes, edges, { maxInf: 100 }).length, 0, "一个中间物可能只是巧合");
});

test("PMI：常见的东西一起出现，不算关联", () => {
  // 两个各出现 1000 次的枢纽，只撞见 1 次，总量 12000 → 低于偶然期望，归零
  assert.equal(pmi(1, 1000, 1000, 12000), 0);
  // 两个各 100 次的东西稳定共现 50 次 → 远超偶然
  assert.ok(pmi(50, 100, 100, 12000) > 4, "稀有且稳定共现必须给出高分");
});
