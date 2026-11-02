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
  applyEvent, applySeqLinks, classify, decayTo, emptyIndex, entitiesOf, isNoise, loadConfig, prune, readNewLines, regionOf,
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

test("心跳不是知识：没有对象的不建实体，同一句话重复再多也只有一份强度", () => {
  // 用户原话两连问：「为什么无聊的第 xx 次审计，也要记？」
  //             「3条 残留(已清理): fused readSet=21 …… 这种记得干嘛？难道是里程碑？」
  // 旧版把每行的 action 无条件建成实体，于是 reset-fired 3,220 次、residue-check 2,940 次
  // 占掉全部提及的 48%，真实文件（166 个，最高 228 次）全被压成暗雾。
  const repo = "/repo";
  const beat = { ts: "2026-10-01T01:00:00Z", action: "reset-fired", evidence: "prompt:有 kw=10 budget=10 eff=0" };
  assert.deepEqual(entitiesOf(beat, repo), [], "计数器心跳不指认任何对象，不该长成节点");

  // 同一句话出现三十次：种数仍是 1，强度按 1×√(1/30) 掉下去，而不是涨到 30。
  const idx = emptyIndex();
  const line = { ts: "2026-10-01T01:00:00Z", action: "residue-check", evidence: "43条 残留(已清理): readSet=1" };
  for (let i = 0; i < 30; i++) {
    applyEvent(idx, { ...line, ts: `2026-10-${String(1 + (i % 20)).padStart(2, "0")}T01:00:00Z` }, repo, Date.now());
  }
  const r43 = idx.entities["rule:第43条"];
  assert.equal(r43.c, 30, "原始次数要留着：PMI 的分母要真实频次");
  assert.equal(r43.g.length, 1, "readSet=1 和 readSet=2 是同一件事的两个读数，抹掉数字后只有一种样子");
  assert.ok(r43.s < 0.2, `重复三十遍的强度必须远小于 1，实得 ${r43.s}`);

  // 换一个真的不同的说法，才算第二种样子，强度才往上走。
  applyEvent(idx, { ...line, evidence: "43条 残留(已清理): fused stall=1" }, repo, Date.now());
  assert.equal(r43.g.length, 2);
  assert.ok(r43.s > 0.2, `见过第二种样子后强度应当回升，实得 ${r43.s}`);
});

test("强度：每次都是新样子时退回计数，翻来覆去一句时趋近 0", () => {
  // s = 种数 × √(种数/次数)。这是本工具唯一的"重要度"公式，错了会静默——
  // 图还是画得出来，只是大小全错，而且几个月后才发现。
  const repo = "/repo";
  const idx = emptyIndex();
  // 注意变化的是**词**不是数字：抹掉数字是本工具的判据之一，用 i 做区别只会得到同一句话。
  const verbs = ["删除", "覆盖", "外传", "提权", "绕过", "截断", "改签", "重放", "注入", "清空"];
  for (const v of verbs) {
    applyEvent(idx, { ts: "2026-10-01T01:00:00Z", action: "deny", evidence: `拦下${v}命令 src/a.mjs` }, repo, Date.now());
  }
  const e = idx.entities["file:src/a.mjs"];
  assert.equal(e.g.length, 10, "十句不同的话 = 十种样子");
  assert.ok(Math.abs(e.s - 10) < 0.001, `种数=次数时 s 应等于次数，实得 ${e.s}`);
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

test("seq 链：相邻行连边，链头不当枢纽（2026-11-02）", () => {
  const idx = emptyIndex();
  idx.entities = {
    "file:a": { t: "file", n: "a" }, "file:b": { t: "file", n: "b" }, "file:c": { t: "file", n: "c" },
  };
  idx.edges = {};
  applySeqLinks(idx, [[{ ids: ["file:a"] }, { ids: ["file:b"] }, { ids: ["file:c"] }]], Date.now());
  assert.deepEqual(Object.keys(idx.edges).sort(), ["seq|file:a|file:b", "seq|file:b|file:c"], "只连相邻行，不能 a↔c");
});
