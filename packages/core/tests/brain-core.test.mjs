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
  applyEvent, decayTo, emptyIndex, prune, readNewLines, regionOf,
} from "../tools/lib/brain-core.mjs";

test("分区：条号与高危进脑干，工具与机械动作进小脑，代码进左脑，文档进右脑", () => {
  assert.equal(regionOf("rule", "第43条"), "stem");
  assert.equal(regionOf("action", "deny"), "stem");
  assert.equal(regionOf("action", "stall-fuse"), "stem");
  assert.equal(regionOf("tool", "Bash"), "cerebellum");
  assert.equal(regionOf("action", "reset-fired"), "cerebellum");
  assert.equal(regionOf("file", "packages/core/src/core/state.mjs"), "left");
  assert.equal(regionOf("file", "packages/core/docs/RULES.md"), "right");
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

test("修剪：超过一年未动且强度见底的实体被遗忘，新的留下", () => {
  const idx = emptyIndex();
  idx.entities["file:old.mjs"] = { t: "file", n: "old.mjs", r: "right", c: 1, f: "2024-01-01T00:00:00Z", l: "2024-01-01T00:00:00Z", s: 1, x: [] };
  idx.entities["file:new.mjs"] = { t: "file", n: "new.mjs", r: "right", c: 1, f: "2026-11-01T00:00:00Z", l: "2026-11-01T00:00:00Z", s: 1, x: [] };
  const dropped = prune(idx, Date.parse("2026-11-02T00:00:00Z"));
  assert.equal(dropped, 1);
  assert.ok(!idx.entities["file:old.mjs"], "两年前的一闪而过应该被忘掉");
  assert.ok(idx.entities["file:new.mjs"], "昨天的必须留下");
});
